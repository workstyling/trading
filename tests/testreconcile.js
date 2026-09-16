// Сверка открытых позиций с биржей и кошельком.
//
// Журнал строит позиции из окна последних 350 ордеров в каждом статусе.
// Продажа, уехавшая за край окна, оставляет позицию открытой навсегда: PUMP
// на $1163 и CRO на $1197 числились открытыми, хотя в кошельке их нет, а ZEC
// показывал +$1352 (+189%) за 230 дней на монете, от которой осталась пыль.
//
// Лечится догрузкой по конкретной монете, а не списанием: у биржи по одному
// продукту ордера спрашиваются отдельно, и настоящие цены находятся. Что не
// нашлось, но чего нет в кошельке, закрывается с пометкой — цену такого
// выхода мы не знаем, и в прибыль она не идёт ни плюсом, ни минусом.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
const now = Date.now();

const order = (id, side, size, usd, t) => ({
  order_id: id, side, product_id: 'X-USD', status: 'FILLED',
  filled_size: String(size), total_value: String(usd),
  average_filled_price: String(usd / size), created_time: new Date(t).toISOString(),
  last_fill_time: new Date(t).toISOString(),
});
const position = (over = {}) => ({
  coin: 'X', entryAt: now - 86400000, origSize: 1000, totalSize: 1000,
  costTotal: 1000, restCost: 1000, realized: 0,
  buys: [{ orderId: 'b1', price: 1, size: 1000, usd: 1000, t: now - 86400000 }],
  sells: [], ctx: { score: 5 }, ...over,
});

function load({ wallet = [], orders = [], fail = false, open = { X: position() } } = {}) {
  const saved = [];
  const files = {};
  const ctx = {
    console: { log: () => { }, error: () => { } }, Math, JSON, Date, Set, Object, Number, parseFloat, Array,
    journal: { open, closed: [] },
    JOURNAL_FILE: 'trade-journal.json',
    fs: { writeFileSync: (p, data) => { files[p] = data; } },
    saveJournal: () => saved.push(1),
    fetchAccountBalances: async () => wallet,
    normalizeOrder: o => ({ ...o }),
    client: { listOrders: async () => { if (fail) throw new Error('биржа молчит'); return { orders }; } },
  };
  vm.createContext(ctx);
  const i = src.indexOf('function journalApplySell(');
  const j = src.indexOf('async function journalOpenLive(');
  vm.runInContext(src.slice(i, j) + ';this.reconcile = journalReconcile; this.stats = journalStats;', ctx);
  ctx.saved = () => saved.length;
  ctx.files = files;
  return ctx;
}

(async () => {
  console.log('\nХолостой прогон ничего не меняет');
  {
    const ctx = load({ wallet: [], orders: [order('s1', 'SELL', 1000, 1100, now - 3600000)] });
    const before = JSON.stringify(ctx.journal);
    const out = await ctx.reconcile({});
    ok(out.applied === false, 'по умолчанию прогон холостой');
    ok(out.changed === 1, 'но изменение найдено и показано');
    ok(JSON.stringify(ctx.journal) === before, 'журнал в памяти остался прежним');
    ok(ctx.saved() === 0, 'и на диск ничего не писалось');
    ok(Object.keys(ctx.files).length === 0, 'снимок при холостом прогоне не создаётся');
  }

  console.log('\nНайденная продажа закрывает позицию по настоящей цене');
  {
    const ctx = load({ wallet: [], orders: [order('s1', 'SELL', 1000, 1100, now - 3600000)] });
    const out = await ctx.reconcile({ apply: true });
    ok(out.applied === true && ctx.saved() === 1, 'с apply журнал записан один раз');
    ok(ctx.files['trade-journal.json.before-reconcile'], 'снимок «до» положен рядом');
    ok(!ctx.journal.open.X, 'позиция больше не открыта');
    const rec = ctx.journal.closed[0];
    ok(rec && near(rec.pnl, 100), 'прибыль посчитана из найденного ордера, а не выдумана', rec && '$' + rec.pnl);
    ok(rec && !rec.unknownExit, 'выход известен, пометки нет');
    ok(out.report[0].added.length === 1 && out.report[0].added[0].side === 'SELL', 'в отчёте видно, что догрузилось');
  }

  console.log('\nПропавшая покупка тоже догружается');
  {
    const ctx = load({ wallet: [{ currency: 'X', total: '1500' }],
      orders: [order('b2', 'BUY', 500, 400, now - 7200000)] });
    await ctx.reconcile({ apply: true });
    const pos = ctx.journal.open.X;
    ok(pos && pos.totalSize === 1500, 'размер позиции сошёлся с кошельком', pos && String(pos.totalSize));
    ok(pos && near(pos.costTotal, 1400), 'и себестоимость выросла на потраченное');
  }

  console.log('\nМонеты нет в кошельке, продажи не нашлись');
  {
    const ctx = load({ wallet: [], orders: [] });
    const out = await ctx.reconcile({ apply: true });
    const rec = ctx.journal.closed[0];
    ok(rec && rec.unknownExit === true, 'позиция закрыта с пометкой «цена выхода неизвестна»');
    ok(rec && near(rec.unknownCost, 1000), 'и вложенное названо числом', rec && '$' + rec.unknownCost);
    ok(rec && rec.pnl === 0, 'прибыль по ней не выдумана');
    ok(/не отнесены ни к прибыли, ни к убытку/.test(out.report[0].action), 'в отчёте сказано прямо');
    // Такая запись не должна портить статистику ни победой, ни поражением
    const st = ctx.stats();
    ok(st.overall.n === 0, 'в статистику закрытых она не попадает', String(st.overall.n));
    ok(st.unknownExits && st.unknownExits.n === 1 && near(st.unknownExits.cost, 1000),
      'но показана отдельной строкой с суммой');
  }

  console.log('\nКошелёк знает другое количество');
  {
    const ctx = load({ wallet: [{ currency: 'X', total: '400' }], orders: [] });
    const out = await ctx.reconcile({ apply: true });
    const pos = ctx.journal.open.X;
    ok(pos && pos.totalSize === 400, 'позиция приведена к кошельку');
    ok(pos && near(pos.restCost, 400), 'себестоимость поделена в той же доле', pos && '$' + pos.restCost);
    ok(pos && near(pos.unknownCost, 600), 'списанное названо числом');
    ok(/списаны без цены выхода/.test(out.report[0].action), 'и объяснено в отчёте');
  }

  console.log('\nЧего сверка не трогает');
  {
    const ok1 = load({ wallet: [{ currency: 'X', total: '1000' }], orders: [order('s9', 'SELL', 500, 500, now)] });
    const out = await ok1.reconcile({ apply: true });
    ok(out.changed === 0 && ok1.journal.open.X.totalSize === 1000,
      'подтверждённая кошельком позиция не трогается даже при новых ордерах');
    ok(ok1.saved() === 0, 'и журнал не переписывается');
    // Расхождение в пределах 5% — это округление, а не пропажа
    const small = load({ wallet: [{ currency: 'X', total: '970' }], orders: [] });
    ok((await small.reconcile({ apply: true })).changed === 0, 'расхождение до 5% не считается пропажей');
    // Ордера старше входа — чужая история этой монеты
    const older = load({ wallet: [], orders: [order('old', 'SELL', 1000, 5000, now - 90000000)] });
    await older.reconcile({ apply: true });
    ok(older.journal.closed[0].unknownExit === true, 'ордер раньше входа в позицию не берётся');
    // Уже известный ордер не применяется второй раз
    const dup = load({ open: { X: position({ sells: [{ orderId: 's1', price: 1.1, size: 500, usd: 550, t: now }],
      totalSize: 500, restCost: 500 }) }, wallet: [], orders: [order('s1', 'SELL', 500, 550, now)] });
    await dup.reconcile({ apply: true });
    ok(dup.journal.closed[0].sells.length === 1, 'известный ордер не дублируется');
  }

  console.log('\nБиржа не ответила');
  {
    const ctx = load({ wallet: [], orders: [], fail: true });
    const out = await ctx.reconcile({ apply: true });
    ok(ctx.journal.open.X, 'позиция остаётся как была');
    ok(/биржа не ответила/.test(out.report[0].action), 'и в отчёте названа причина');
    ok(ctx.saved() === 0, 'молчание биржи не повод переписывать журнал');
  }

  console.log('\nДоступ и связи в коде');
  ok(/app\.post\('\/api\/journal\/reconcile'/.test(src), 'сверка доступна снаружи');
  {
    const ep = src.slice(src.indexOf("app.post('/api/journal/reconcile'"), src.indexOf('// Хвост журнала по ключу'));
    ok(/constantTimeTokenEquals/.test(ep) && /status\(403\)/.test(ep), 'только по ключу');
    ok(/req\.query\.apply === '1'/.test(ep), 'и запись только по явному apply');
  }
  ok(/journalApplySell\(pos, \{ orderId: o\.order_id/.test(src), 'живой учёт считает тем же кодом, что и сверка');

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
