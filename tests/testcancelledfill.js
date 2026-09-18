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
  // Без заказанного объёма сравнить не с чем: осторожнее назвать частичной
  ok(f({ status: 'CANCELLED', filled_size: '5', order_configuration: {} }) === true,
    'без заказанного объёма считаем частичной — снятая заявка полной не бывает');
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

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
