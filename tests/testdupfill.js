// Одно исполнение, записанное дважды.
//
// Проверка исполнений идёт по расписанию раз в полминуты и вдобавок по
// нажатию клиента сразу после сделки — два вызова живут одновременно. Между
// «этого ордера ещё нет в обработанных» и отметкой стояло ожидание отправки в
// Telegram: окно, в которое второй вызов заходил на тот же ордер.
//
// По ARB покупка 2807.03 легла в журнал дважды. Журнал держал позицию
// открытой на $492.63, хотя кошелёк по ARB был пуст, а настоящий итог круга —
// не «+$40.29 и ещё $492.63 вложено», а закрытая сделка на +$9.53. Ошибка
// тихая: числа выглядят обычно, и найти её можно только сверкой с кошельком.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// Настоящая позиция с боевого сервера: покупка 226c0ce9 записана дважды
const ARB = {
  coin: 'ARB', entryAt: 1789655220000, origSize: 15479.04, totalSize: 2807.0300000000007,
  costTotal: 2669.22, restCost: 492.63, realized: 40.29,
  buys: [
    { orderId: '226c0ce9', price: 0.1642899511583417, size: 2807.03, usd: 461.86, t: 1789655220000 },
    { orderId: '226c0ce9', price: 0.1642899511583417, size: 2807.03, usd: 461.86, t: 1789655220000 },
    { orderId: '80194046', price: 0.1762087464416505, size: 4935.07, usd: 870.91, t: 1789687200000 },
    { orderId: '91d56da6', price: 0.1771399452728346, size: 4929.91, usd: 874.59, t: 1789689420000 }],
  sells: [
    { orderId: '5132780b', price: 0.16559, size: 2807.03, usd: 464.35, pnl: 2.49, t: 1789659300000 },
    { orderId: '5a96c5d7', price: 0.17698, size: 4935.07, usd: 872.54, pnl: 22.99, t: 1789688100000 },
    { orderId: '5b3360f8', price: 0.17868, size: 4929.91, usd: 880.00, pnl: 14.81, t: 1789691340000 }],
  ctx: { score: 5, rbTag: null },
};

function load(open) {
  const journal = { open: JSON.parse(JSON.stringify(open)), closed: [] };
  const logs = [];
  const ctx = {
    journal, Math, JSON, Date, parseFloat, Array, Set, Object, Number, String,
    console: { log: m => logs.push(m), error: m => logs.push('ОШИБКА ' + m) },
    saveJournal: () => { ctx.saved = (ctx.saved || 0) + 1; },
    latestScores: {}, topLosersCache: { data: [] }, topVolumeCache: { data: [] },
  };
  vm.createContext(ctx);
  const i = src.indexOf('// Пересчёт записи по её же ордерам');
  const j = src.indexOf('function journalStats()');
  vm.runInContext(src.slice(i, j) + ';this.dedupe = journalDedupeOpen; this.onFill = journalOnFill;', ctx);
  ctx.logs = logs;
  return ctx;
}

console.log('\nПересчёт позиции с повтором');
{
  const ctx = load({ ARB });
  ok(!ctx.journal.open.ARB, 'пустая позиция закрыта, а не осталась висеть');
  const rec = ctx.journal.closed[0];
  ok(rec && rec.coin === 'ARB', 'круг записан закрытой сделкой');
  // Куплено 2207.36, продано 2216.89 — разница и есть итог круга
  ok(rec && near(rec.pnl, 9.53, 0.05), 'итог круга +$9.53, а не +$40.29 при открытом остатке',
    rec ? '$' + rec.pnl : 'записи нет');
  ok(rec && near(rec.costTotal, 2207.36, 0.05), 'себестоимость без задвоенной покупки',
    rec ? '$' + rec.costTotal : '');
  ok(rec && rec.buys.length === 3, 'повтор убран, остальные покупки на месте');
  ok(rec && rec.sells.length === 3, 'продажи не тронуты');
  ok(rec && rec.buys.filter(b => b.orderId === '226c0ce9').length === 1, 'номер ордера встречается один раз');
  ok(ctx.saved >= 1, 'файл журнала переписан');
  ok(ctx.dedupe() === 0, 'второй проход уже нечего чинить — починка не идёт по кругу');
}

console.log('\nЗдоровая позиция не трогается');
{
  const clean = { coin: 'ENA', entryAt: 1, origSize: 100, totalSize: 100, costTotal: 1000,
    restCost: 1000, realized: 0, buys: [{ orderId: 'b1', price: 10, size: 100, usd: 1000, t: 1 }],
    sells: [], ctx: {} };
  const ctx = load({ ENA: clean });
  ok(ctx.journal.open.ENA && ctx.journal.open.ENA.totalSize === 100, 'позиция осталась как была');
  ok(ctx.saved === undefined, 'и файл ради неё не переписывается');
  // Частично проданная тоже остаётся открытой
  const half = { coin: 'RAY', entryAt: 1, origSize: 100, totalSize: 40, costTotal: 1000,
    restCost: 400, realized: 20, buys: [{ orderId: 'b1', price: 10, size: 100, usd: 1000, t: 1 }],
    sells: [{ orderId: 's1', price: 10.3, size: 60, usd: 620, pnl: 20, t: 2 }], ctx: {} };
  const ctx2 = load({ RAY: half });
  ok(ctx2.journal.open.RAY && ctx2.journal.open.RAY.totalSize === 40, 'недопроданная позиция не закрывается');
}

console.log('\nЖивой учёт не берёт один ордер дважды');
{
  const ctx = load({});
  const fill = (side, size, usd, price, t, id) => ctx.onFill({ side, product_id: 'ARB-USD', order_id: id,
    filled_size: String(size), total_value: String(usd), average_filled_price: String(price),
    created_time: new Date(t).toISOString() });
  fill('BUY', 2807.03, 461.86, 0.16429, 1789655220000, '226c0ce9');
  fill('BUY', 2807.03, 461.86, 0.16429, 1789655220000, '226c0ce9');   // тот же ордер второй раз
  const pos = ctx.journal.open.ARB;
  ok(pos && pos.buys.length === 1, 'повторный вызов не добавляет вторую покупку',
    pos ? 'покупок ' + pos.buys.length : 'позиции нет');
  ok(pos && near(pos.totalSize, 2807.03), 'и размер позиции не удваивается', pos ? String(pos.totalSize) : '');
  ok(pos && near(pos.restCost, 461.86), 'и себестоимость тоже', pos ? '$' + pos.restCost.toFixed(2) : '');
  ok(ctx.logs.some(m => /уже учтён/.test(m)), 'повтор назван в журнале сервера, а не проглочен молча');

  // Продажу повторять тоже нельзя: это вычло бы монеты дважды
  fill('SELL', 1000, 170, 0.17, 1789659300000, 's1');
  const afterOne = ctx.journal.open.ARB.totalSize;
  fill('SELL', 1000, 170, 0.17, 1789659300000, 's1');
  ok(near(ctx.journal.open.ARB.totalSize, afterOne), 'повтор продажи не вычитает монеты второй раз',
    String(ctx.journal.open.ARB.totalSize));
  ok(ctx.journal.open.ARB.sells.length === 1, 'и вторую продажу в позицию не кладёт');

  // А другой ордер по той же монете учитывается как обычно
  fill('BUY', 100, 20, 0.2, 1789660000000, 'b2');
  ok(ctx.journal.open.ARB.buys.length === 2, 'другой номер ордера учитывается');
}

console.log('\nОтметка ордера стоит до ожидания');
{
  // Источник гонки: между проверкой «не обработан» и отметкой стоял await.
  const loop = src.slice(src.indexOf('for (const o of filled) {'),
    src.indexOf('if (changed) {', src.indexOf('for (const o of filled) {')));
  const claim = loop.indexOf('notifiedFills.push(o.order_id)');
  const send = loop.indexOf('await sendTelegram(');
  const journal = loop.indexOf('journalOnFill(o)');
  ok(claim > 0 && send > 0, 'оба места на месте');
  ok(claim < send, 'ордер отмечается ДО отправки сообщения, а не после');
  ok(journal > 0 && journal < send, 'и в журнал он попадает там же, до первого ожидания');
  const head = loop.slice(0, claim);
  ok(!/await /.test(head), 'между проверкой и отметкой нет ни одного ожидания',
    (head.match(/await [a-zA-Z]+/g) || []).join(', ') || 'чисто');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
