// Снятая заявка тоже могла частично исполниться.
//
// Учёт брал только status === 'FILLED'. Заявка, успевшая продать часть объёма
// и снятая, получает статус CANCELLED — и вся проданная по ней часть не
// попадала никуда: ни в уведомление, ни в журнал, ни в сверку. Деньги уходили
// молча.
//
// Это и есть источник «выходов с неизвестной ценой». В окне ордеров лежали
// CP на $629.44, CRO на $1199.12, PUMP на $1184.88 и AVAX на $116.64 — все
// CANCELLED с исполненной частью, и все четыре позиции журнал списал как
// «продано неизвестно по чём» на $2477. Ничего неизвестного в них не было.
//
// Видно это стало на USELESS: панель предлагала продать 11858.70, биржа
// отклоняла — в кошельке 11820.90. Разница 37.80 ушла снятой заявкой.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');

const ctx = { Set, Object, Number, parseFloat, console: { log: () => {} } };
vm.createContext(ctx);
{
  const i = src.indexOf("const ORDER_DONE = new Set(");
  const j = src.indexOf('async function checkFilledOrders(');
  vm.runInContext(src.slice(i, j), ctx);
}

// Настоящая снятая заявка по USELESS: заказано 11858.7, продалось 37.8
const cancelledPart = { status: 'CANCELLED', side: 'SELL', filled_size: '37.8',
  order_configuration: { limit_limit_gtc: { base_size: '11858.7', limit_price: '0.26' } } };
const cancelledEmpty = { status: 'CANCELLED', side: 'BUY', filled_size: '0',
  order_configuration: { limit_limit_gtc: { base_size: '1000' } } };
const openPart = { status: 'OPEN', side: 'SELL', filled_size: '37.8',
  order_configuration: { limit_limit_gtc: { base_size: '11858.7' } } };
const done = { status: 'FILLED', side: 'BUY', filled_size: '11858.7',
  order_configuration: { market_market_ioc: { quote_size: '3078.12' } } };

console.log('\nКакое исполнение считается состоявшимся');
{
  const f = ctx.hasRealFill;
  ok(f(done) === true, 'полностью исполненный — как и раньше');
  ok(f(cancelledPart) === true, 'снятая заявка с проданной частью тоже считается');
  ok(f(cancelledEmpty) === false, 'снятая без исполнения — нет');
  // ОТКРЫТУЮ БРАТЬ НЕЛЬЗЯ: она ещё доисполнится, и записанное число устареет
  // в ту же минуту. Считаем только когда исполненная часть окончательна.
  ok(f(openPart) === false, 'открытая заявка с частичным исполнением ещё не итог');
  ok(f({ status: 'EXPIRED', filled_size: '5' }) === true, 'истёкшая с исполнением считается');
  ok(f({ status: 'EXPIRED', filled_size: '0' }) === false, 'истёкшая без исполнения — нет');
  ok(f(null) === false && f({}) === false, 'мусор не ломает проверку');
}

console.log('\nЧастичное исполнение названо словом');
{
  const f = ctx.isPartialFill;
  ok(f(cancelledPart) === true, 'снятая заявка, продавшая часть — частичная');
  ok(f(done) === false, '«исполнен полностью» частичным не называется');
  // Заявка снята уже после полного исполнения — объём взят весь
  ok(f({ status: 'CANCELLED', filled_size: '1000',
    order_configuration: { limit_limit_gtc: { base_size: '1000' } } }) === false,
    'снята после полного исполнения — это не частичная');
  // РЫНОЧНЫЙ ОРДЕР ЗАКАЗАН ДЕНЬГАМИ, А НЕ МОНЕТАМИ.
  //
  // Здесь стояло «раз объём неизвестен, а заявка снята — значит частично», и
  // это оказалось неверно ровно для рыночных ордеров. Coinbase исполняет их
  // как IOC: неисполненный хвост снимается, и полностью исполненная покупка
  // получает статус CANCELLED — не потому, что что-то не вышло, а потому что
  // так устроен этот тип. Объёма в монетах у неё нет: заказана сумма.
  //
  // Настоящий ордер PYTH с биржи: заказано $3303.32, потрачено $3303.317 —
  // недобор в треть цента. В Telegram улетело «BUY ЧАСТИЧНО», и пришлось идти
  // на биржу проверять, всё ли купилось.
  const pyth = { status: 'CANCELLED', side: 'BUY', filled_size: '49118.6',
    filled_value: '3298.369483', total_value: '3303.31703722',
    order_configuration: { market_market_ioc: { quote_size: '3303.32' } } };
  ok(f(pyth) === false, 'рыночная покупка на всю сумму частичной не называется',
    (3303.31703722 / 3303.32 * 100).toFixed(4) + '% заказанной суммы');
  ok(ctx.orderQuoteSize(pyth) === 3303.32, 'заказанная сумма берётся из настройки ордера');
  ok(ctx.orderBaseSize(pyth) === 0, 'а объёма в монетах у неё нет вовсе');
  // Настоящий недобор по деньгам — по-прежнему частичное
  ok(f({ ...pyth, total_value: '1650' }) === true, 'половина заказанной суммы — частичное');
  ok(f({ ...pyth, total_value: '3300' }) === true, 'недобор в $3 — тоже',
    (3300 / 3303.32 * 100).toFixed(2) + '%');
  // Ни объёма, ни суммы: судить не по чему — молчим о частичности, но само
  // уведомление уходит. Пугать словом, которое нечем проверить, хуже.
  ok(f({ status: 'CANCELLED', filled_size: '5', order_configuration: {} }) === false,
    'без объёма и без суммы частичность не выдумывается');
  ok(ctx.orderBaseSize(cancelledPart) === 11858.7, 'заказанный объём читается из настройки ордера');
  ok(ctx.orderBaseSize(done) === 0, 'у рыночной покупки объёма в монетах нет — это сумма');
}

console.log('\nЧисла USELESS сходятся');
{
  const bought = 11858.7, soldAway = 37.8, wallet = 11820.9;
  ok(Math.abs(bought - soldAway - wallet) < 0.01,
    'выбранное минус проданное снятой заявкой = кошелёк', String(bought - soldAway));
  // Прежний учёт видел только покупку — отсюда и «свободно только 11820.90»
  ok(bought > wallet, 'по прежнему учёту позиция выглядела больше, чем она есть');
}

console.log('\nИстория не выстреливает задним числом');
{
  // Снятые заявки лежат в окне месяцами, и в списке обработанных их не было
  // никогда: без отсечки первый же проход выдал бы двенадцать сообщений и
  // открыл позицию по CAP покупкой от 21 августа, которой в кошельке нет.
  ok(/const PARTIAL_BASELINE = /.test(src), 'метка отсечки есть');
  ok(/if \(!notifiedFills\.includes\(PARTIAL_BASELINE\)\)/.test(src), 'отсечка делается один раз');
  const block = src.slice(src.indexOf('if (!notifiedFills.includes(PARTIAL_BASELINE))'),
    src.indexOf('let changed = false;', src.indexOf('if (!notifiedFills.includes(PARTIAL_BASELINE))')));
  ok(/if \(o\.status === 'FILLED'\) continue;/.test(block),
    'помечаются только снятые — полные учитывались и раньше');
  ok(/notifiedFills\.push\(PARTIAL_BASELINE\)/.test(block) && /writeFileSync\(NOTIFIED_FILE/.test(block),
    'метка записывается в файл, который переживает выкладку');
  // Метка ставится ПОСЛЕ идентификаторов: обрезка хвостом её не съест
  ok(block.indexOf('notifiedFills.push(PARTIAL_BASELINE)') < block.indexOf('slice(-800)'),
    'метка попадает в хвост, который обрезка оставляет');
  ok(!/^[0-9a-f-]+$/.test('#partial-fills-baselined'), 'метка не может совпасть с номером ордера');
}

console.log('\nСверка ищет и снятые заявки');
{
  const rec = src.slice(src.indexOf('async function journalReconcile'), src.indexOf('const snapshot = JSON.stringify(journal)'));
  ok(/order_status: \['FILLED', 'CANCELLED', 'EXPIRED'\]/.test(rec),
    'сверка спрашивает у биржи и снятые ордера');
  ok(/\.map\(normalizeOrder\)\.filter\(hasRealFill\)/.test(rec),
    'и оставляет из них те, где что-то действительно исполнилось');
  // Иначе именно те продажи, из-за которых позиция разошлась с кошельком,
  // не находились — и списывались как «выход с неизвестной ценой».
  ok(/product_ids: \[coin \+ '-USD', coin \+ '-USDC'\]/.test(rec), 'обе долларовые пары по-прежнему спрашиваются');
}

console.log('\nУведомление не выдаёт часть за целое');
{
  const loop = src.slice(src.indexOf('for (const o of filled) {'), src.indexOf('if (changed) {', src.indexOf('for (const o of filled) {')));
  ok(/const part = isPartialFill\(o\);/.test(loop), 'частичность определяется');
  ok(/part \? 'ЧАСТИЧНО' : 'FILLED'/.test(loop), 'и попадает в заголовок сообщения');
  ok(/Заявка снята, исполнилось/.test(loop), 'и сказано, какая доля объёма прошла');
}

(async () => {
  console.log('\nОтмена не выбрасывает проданное из панели');
  {
    // Вторая половина той же ошибки, уже в панели. Кнопка отмены в таблице
    // ордеров снимала ордер из выбранного ВСЕГДА, а вторая кнопка смотрела на
    // снимок в памяти ДО отмены — он отстаёт до восьми секунд, а исполниться
    // заявка могла в последнюю секунду перед нажатием. Проданные монеты
    // выпадали из расчёта, и панель предлагала продать то, чего уже нет.
    const h = fs.readFileSync('public/index.html', 'utf8');
    const i = h.indexOf('async function dropFromSelectedIfEmpty');
    const j = h.indexOf('\n    }', i) + 6;
    const mk = (passes) => {
      let n = 0;
      const c = { Number, String, parseFloat, Promise, setTimeout: fn => fn(),
        allOrders: [], selectedOrders: ['a', 'b'], saved: 0,
        loadLatestOrders: async () => { c.allOrders = passes[Math.min(n, passes.length - 1)]; n++; },
        saveSelectedOrders: () => { c.saved++; } };
      vm.createContext(c);
      vm.runInContext(h.slice(i, j) + ';this.drop = dropFromSelectedIfEmpty;', c);
      return c;
    };
    let c = mk([[{ order_id: 'a', status: 'CANCELLED', filled_size: '0' }]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'b' && c.saved === 1,
      'снятая заявка без исполнения убирается из выбранного', c.selectedOrders.join());

    c = mk([[{ order_id: 'a', status: 'CANCELLED', filled_size: '37.8' }]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'a,b' && c.saved === 0,
      'снятая заявка с проданной частью остаётся — иначе монеты выпадут из расчёта');

    c = mk([[]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'a,b',
      'ордера не видно — оставляем: потерять исполнение хуже, чем лишнюю строку');

    // Отмена доходит до биржи не мгновенно: первый ответ ещё «в стакане»
    c = mk([[{ order_id: 'a', status: 'OPEN', filled_size: '0' }],
            [{ order_id: 'a', status: 'CANCELLED', filled_size: '37.8' }]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'a,b',
      'исполнение, доехавшее вторым ответом, тоже сохраняется');

    for (const order of [
      { status: 'OPEN', filled_size: '0' }, { status: 'PENDING', filled_size: '0' },
      { status: 'QUEUED', filled_size: '0' }, { status: 'CANCEL_QUEUED', filled_size: '0' },
      { status: 'CANCELLED' }, { status: 'CANCELLED', filled_size: null },
      { status: 'CANCELLED', filled_size: '' }, { status: 'CANCELLED', filled_size: 'bad' },
      { filled_size: '0' },
    ]) {
      c = mk([[{ order_id: 'a', ...order }]]);
      await c.drop('a');
      ok(c.selectedOrders.join() === 'a,b' && c.saved === 0,
        'незавершённая отмена или неизвестное исполнение сохраняет ордер', JSON.stringify(order));
    }

    // Обе кнопки отмены идут через одну проверку
    ok(!/const hasFills = order && parseFloat\(order\.filled_size/.test(h),
      'проверки по устаревшему снимку до отмены не осталось');
    const calls = (h.match(/await dropFromSelectedIfEmpty\(orderId\)/g) || []).length;
    ok(calls === 3, 'все три пути отмены проверяют одинаково', 'мест: ' + calls);
    // Слепого снятия из выбранного не осталось ни в одном из них
    for (const name of ['cancelOrderAndRemove', 'cancelOrderFromSelected']) {
      const fn = h.slice(h.indexOf('function ' + name), h.indexOf('function ' + name) + 1200);
      ok(!/selectedOrders\.splice/.test(fn), name + ': не снимает из выбранного вслепую');
    }
    const inline = h.slice(h.indexOf("showCustomAlert('Order cancelled!')", h.indexOf('cancelOrderAndRemove') + 2000));
    ok(!/selectedOrders\.splice/.test(inline.slice(0, 700)), 'кнопка в таблице тоже');

    // На телефоне отмена выбранного не трогает вовсе — там этой дыры нет
    const m = fs.readFileSync('public/mobile/index.html', 'utf8');
    const mc = m.slice(m.indexOf('async function cancelOrder(id)'), m.indexOf('async function cancelOrder(id)') + 600);
    ok(!/selectedOrders/.test(mc), 'телефон при отмене выбранное не трогает — правка ему не нужна');
  }

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
