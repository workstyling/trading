// Выбранные ордера не должны пропадать из карточек.
//
// Биржа отдаёт по 350 последних ордеров в каждом статусе. Выбранная сделка
// старше этого окна просто исчезала: позиция выглядела меньше, чем она есть,
// денежные потоки по ней не сходились, а отрицательный остаток ещё и
// принимался за закрытую позицию. Во время внешней проверки трёх сохранённых
// идентификаторов в окне не было, и один из них — исполненная покупка,
// совпадающая по количеству и цене со сторожем INX.
//
// Такие ордера догружаются по идентификатору поштучно.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');

const build = (getOrder, selected) => {
  const ctx = {
    console: { log: () => { }, error: () => { } }, Map, Set, Date, JSON,
    loadSelectedOrders: () => ({ selected }),
    normalizeOrder: (o) => ({ order_id: o.order_id, product_id: o.product_id, filled_size: o.filled_size }),
    client: { getOrder },
  };
  vm.createContext(ctx);
  const i = src.indexOf('const pinnedOrders = new Map();');
  const j = src.indexOf('async function finishOrders');
  vm.runInContext(src.slice(i, j) +
    ';this.load = loadPinnedOrders; this.pinned = pinnedOrders; this.failed = pinnedFailed;', ctx);
  return ctx;
};

(async () => {
  console.log('\nДогрузка выбранных ордеров вне окна');
  {
    let calls = 0;
    const ctx = build(async ({ orderId }) => {
      calls++;
      if (orderId === 'old') return { order: { order_id: 'old', product_id: 'INX-USD', filled_size: '32554' } };
      throw new Error('нет такого ордера');
    }, ['inwindow', 'old', 'gone']);

    const present = new Set(['inwindow']);
    let extra = await ctx.load(present);
    ok(extra.length === 1 && extra[0].order_id === 'old', 'пропавший выбранный ордер догружен',
      extra.map(o => o.order_id).join(','));
    ok(ctx.failed.size === 1, 'недоступный запомнен как неудача, а не запрашивается вечно');

    // Ответ по завершённому ордеру не меняется — второй раз биржу не дёргаем
    const before = calls;
    extra = await ctx.load(present);
    ok(calls === before, 'повторный опрос не ходит на биржу', 'обращений ' + (calls - before));
    ok(extra.length === 1, 'но ордер по-прежнему отдаётся');

    // Вернулся в окно — не дублируем
    extra = await ctx.load(new Set(['inwindow', 'old']));
    ok(extra.length === 0, 'когда ордер снова в окне, копия не добавляется');

    // Снят с выбора — больше не подмешивается
    const ctx2 = build(async () => ({ order: { order_id: 'old', product_id: 'X' } }), []);
    ok((await ctx2.load(new Set())).length === 0, 'невыбранные ордера не догружаются');
  }

  console.log('\nОграничения');
  {
    let calls = 0;
    const many = Array.from({ length: 20 }, (_, i) => 'id' + i);
    const ctx = build(async ({ orderId }) => {
      calls++;
      return { order: { order_id: orderId, product_id: 'X-USD' } };
    }, many);
    await ctx.load(new Set());
    // Двадцать пропавших не должны обернуться двадцатью запросами в один проход
    ok(calls <= 5, 'за один проход догружается не больше пяти', 'обращений ' + calls);
    const first = calls;
    await ctx.load(new Set());
    ok(calls > first, 'остальные подтягиваются следующими проходами', 'стало ' + calls);
  }

  console.log('\nСвязи в коде');
  ok(/const normalizedOrders = allOrders\.map\(normalizeOrder\)/.test(src),
    'нормализация вынесена и используется обеими дорогами');
  ok(/return finishOrders\(normalizedOrders\)/.test(src), 'сборка идёт через общий хвост');
  ok(/PINNED_RETRY_MS/.test(src), 'у неудачи есть срок давности, а не запрет навсегда');

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
