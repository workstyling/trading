// Продано больше, чем журнал видел купленным.
//
// Доля покупки шла в себестоимость целиком, а выручка бралась вся — включая
// монеты, входа которых журнал не видел. На монете O это дало +$2967 (+363%)
// по сделке, где цена прошла +4.0%: известно было 1647 монет за $817.29,
// продано 7351.3 за $3784.64. Одна запись давала 77% всей прибыли журнала
// (3831.70 из них 2967.35) и тянула winrate вверх.
//
// Оценивать можно только покрытую часть продажи: выручку берём в той доле, в
// какой продажу покрывают известные монеты.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// Настоящая запись с боевого сервера
const O = {
  coin: 'O', pnl: 2967.35, pnlPct: 363.07, costTotal: 817.29, holdH: 169.8,
  entryAt: 1787368580089, closedAt: 1787979718759,
  buys: [{ orderId: 'b1', price: 0.49561, size: 1647, usd: 817.2900070875, t: 1787368580089 }],
  sells: [{ orderId: 's1', price: 0.51547, size: 7351.3, usd: 3784.63789273625, pnl: 2967.35, t: 1787979718759 }],
};
// И обычная, у которой сходится всё
const VTHO = {
  coin: 'VTHO', pnl: 18.01, pnlPct: 0.58, costTotal: 3102.43,
  entryAt: 1789131703597, closedAt: 1789179341731, holdH: 13.2,
  buys: [
    { orderId: 'b1', price: 0.0006164489862645, size: 3631026, usd: 2241.6998102452, t: 1789131703597 },
    { orderId: 'b2', price: 0.0005903648633549, size: 1455779, usd: 860.729931565615, t: 1789135533655 }],
  sells: [{ orderId: 's1', price: 0.0006139416471813, size: 5086805, usd: 3120.43479720029, pnl: 18.01, t: 1789179341731 }],
};

function load(closed, open = {}) {
  const journal = { open, closed: JSON.parse(JSON.stringify(closed)) };
  const ctx = { journal, console: { log: () => { }, error: () => { } }, Math, JSON, Date, parseFloat, Array,
    saveJournal: () => { ctx.saved = (ctx.saved || 0) + 1; },
    latestScores: {}, topLosersCache: { data: [] }, topVolumeCache: { data: [] } };
  vm.createContext(ctx);
  const i = src.indexOf('// Пересчёт записи по её же ордерам');
  const j = src.indexOf('function journalStats()');
  vm.runInContext(src.slice(i, j) + ';this.replay = journalReplay; this.repair = journalRepairClosed;' +
    ' this.unmark = journalUnmarkDustPartial; this.onFill = journalOnFill;', ctx);
  return ctx;
}

console.log('\nПересчёт записи по её же ордерам');
{
  const ctx = load([]);
  const again = ctx.replay(O.buys, O.sells);
  // Цена прошла 0.49561 -> 0.51547, это +4.01%. Комиссии обе стороны уже
  // сидят в usd, поэтому честный ответ — около +3.8%, а не +363%.
  ok(near(again.realized, 30.63, 0.05), 'по покрытой части прибыль около $30.63', '$' + again.realized.toFixed(2));
  ok(near(again.realized / O.costTotal * 100, 3.75, 0.05), 'это +3.75% при ходе цены +4.01%');
  ok(near(again.outside, 5704.3, 0.1), 'непокрытая часть продажи названа числом', String(again.outside));
  const same = ctx.replay(VTHO.buys, VTHO.sells);
  ok(near(same.realized, 18.01), 'обычная сделка пересчитывается в те же $18.01', '$' + same.realized.toFixed(2));
  ok(same.outside === 0, 'и непокрытого в ней нет');
  // Продажа раньше любой покупки — не прибыль
  const early = ctx.replay([{ orderId: 'b', size: 10, usd: 100, t: 200 }],
    [{ orderId: 's', size: 10, usd: 150, t: 100 }]);
  ok(early.realized === 0 && early.perSell[0].pnl === 0, 'продажа до первой покупки не даёт прибыли');
  ok(ctx.replay([], []).realized === 0, 'пустая запись не ломает пересчёт');
}

console.log('\nПочинка уже записанного');
{
  // Починка идёт при загрузке, отдельного запуска ждать не нужно
  const ctx = load([VTHO, O]);
  const o = ctx.journal.closed.find(x => x.coin === 'O');
  ok(near(o.pnl, 30.63, 0.05), 'фантомная прибыль заменена настоящей', '$' + o.pnl);
  ok(near(o.pnlPct, 3.75, 0.05), 'и процент тоже', o.pnlPct + '%');
  ok(o.partial === true, 'запись помечена как неполная');
  ok(near(o.sells[0].pnl, 30.63, 0.05), 'в самой продаже число тоже исправлено');
  ok(o.sells[0].outside > 0, 'и видно, сколько монет журнал не покупал');
  ok(o.costTotal === 817.29 && o.buys.length === 1 && o.sells.length === 1, 'ордера остались на месте');
  const v = ctx.journal.closed.find(x => x.coin === 'VTHO');
  ok(v.pnl === 18.01 && v.partial === undefined, 'здоровая запись не тронута');
  ok(ctx.saved === 1, 'файл журнала переписан один раз при загрузке');
  // Повторный запуск ничего не находит: починка не должна идти по кругу
  ok(ctx.repair() === 0, 'второй проход уже нечего чинить');
  ok(ctx.saved === 1, 'и лишний раз файл не переписывается');
  ok(load([VTHO]).saved === undefined, 'здоровый журнал при загрузке не переписывается');
}

console.log('\nЖивой учёт продажи');
{
  const ctx = load([]);
  const fill = (side, size, usd, t, id) => ctx.onFill({ side, product_id: 'O-USD', order_id: id,
    filled_size: String(size), total_value: String(usd), average_filled_price: '1',
    created_time: new Date(t).toISOString() });
  fill('BUY', 1647, 817.29, 1787368580089, 'b1');
  fill('SELL', 7351.3, 3784.64, 1787979718759, 's1');
  const rec = ctx.journal.closed[0];
  ok(rec && near(rec.pnl, 30.63, 0.05), 'новая такая же сделка считается сразу верно', rec ? '$' + rec.pnl : 'записи нет');
  ok(rec && rec.partial === true, 'и сразу помечается неполной');
  ok(rec && rec.sells[0].outside > 0, 'с числом непокрытых монет');
  ok(!ctx.journal.open['O'], 'позиция закрыта, а не осталась с отрицательным остатком');

  // Обычная сделка живого учёта не меняется
  const ctx2 = load([]);
  const f2 = (side, size, usd, t, id) => ctx2.onFill({ side, product_id: 'X-USD', order_id: id,
    filled_size: String(size), total_value: String(usd), average_filled_price: '1',
    created_time: new Date(t).toISOString() });
  f2('BUY', 100, 1000, 1, 'b1');
  f2('SELL', 50, 520, 2, 's1');
  ok(near(ctx2.journal.open['X'].realized, 20), 'частичная продажа даёт свою долю себестоимости');
  ok(near(ctx2.journal.open['X'].restCost, 500), 'и остаток себестоимости уменьшается на неё');
  f2('SELL', 50, 480, 3, 's2');
  ok(ctx2.journal.closed[0] && near(ctx2.journal.closed[0].pnl, 0), 'закрытие даёт сумму частей');
  ok(ctx2.journal.closed[0].partial === undefined, 'и неполной не помечается');
}

console.log('\nПыль — это не «продано больше купленного»');
{
  // Размеры приходят с биржи с восемью знаками, и на честном круге сумма
  // покупок сходится с суммой продаж не до последнего знака: по DASH покупка
  // 7.88 против продажи 7.88 оставила 6e-8 монеты. Прежний относительный
  // порог (1e-9) на этом срабатывал, и чистая сделка получала оранжевое
  // «частично» — подпись, утверждающую то, чего не было.
  const ctx = load([]);
  const f = (side, size, usd, price, t, id) => ctx.onFill({ side, product_id: 'DASH-USD', order_id: id,
    filled_size: String(size), total_value: String(usd), average_filled_price: String(price),
    created_time: new Date(t).toISOString() });
  f('BUY', 7.87999994, 451.45, 57.2013, 1, 'b1');
  f('SELL', 7.88, 461.96, 58.68, 2, 's1');
  const rec = ctx.journal.closed[0];
  ok(rec && near(rec.pnl, 10.51, 0.02), 'прибыль по кругу записана целиком', rec ? '$' + rec.pnl : 'записи нет');
  ok(rec && rec.partial === undefined, 'и «частично» на чистой сделке не появляется');
  ok(rec && rec.sells[0].outside === undefined, 'непокрытого в продаже не записано');

  // А настоящая непокрытая часть — от цента и выше — помечается по-прежнему
  const ctx3 = load([]);
  const f3 = (side, size, usd, price, t, id) => ctx3.onFill({ side, product_id: 'DASH-USD', order_id: id,
    filled_size: String(size), total_value: String(usd), average_filled_price: String(price),
    created_time: new Date(t).toISOString() });
  f3('BUY', 7.88, 451.45, 57.2013, 1, 'b1');
  f3('SELL', 7.8805, 461.99, 58.68, 2, 's1');
  const rec3 = ctx3.journal.closed[0];
  ok(rec3 && rec3.partial === true, 'непокрытое на три копейки всё ещё помечается',
    '$' + (0.0005 * 58.68).toFixed(3));
  ok(/outside \* fill\.price >= 0\.01/.test(src), 'порог непокрытого задан в деньгах, а не в монетах');
}

console.log('\nСнятие ложной пометки с уже записанного');
{
  // Порог исправлен, но запись с ложной пометкой уже лежит в файле и
  // продолжает показывать оранжевое «частично» на чистой сделке. Настоящая
  // запись с боевого сервера: DASH 09-17, куплено 7.88050094, продано
  // 7.880501 — разница 6e-8 монеты, четыре десятитысячных цента.
  const DASH = {
    coin: 'DASH', pnl: 10.51, pnlPct: 2.33, costTotal: 451.45, holdH: 0.4, partial: true,
    entryAt: 1789660000000, closedAt: 1789661440000,
    buys: [{ orderId: 'b1', price: 57.2013, size: 7.88050094, usd: 451.45, t: 1789660000000 }],
    sells: [{ orderId: 's1', price: 58.68, size: 7.880501, usd: 461.96, pnl: 10.51,
      covered: 7.88050094, outside: 5.999999963535174e-8, t: 1789661440000 }],
  };
  const ctx = load([DASH, O, VTHO]);
  const cleaned = ctx.journal.closed.find(x => x.coin === 'DASH');
  ok(cleaned.partial === undefined, 'ложная пометка снята при загрузке');
  ok(cleaned.sells[0].outside === undefined && cleaned.sells[0].covered === undefined,
    'и числа непокрытого убраны — их нечем объяснить');
  ok(cleaned.pnl === 10.51, 'прибыль при этом не тронута');
  const o = ctx.journal.closed.find(x => x.coin === 'O');
  ok(o.partial === true && o.sells[0].outside > 0, 'настоящая неполная запись помечена по-прежнему',
    '$' + (o.sells[0].outside * o.sells[0].price).toFixed(0) + ' непокрыто');

  // Запись с неизвестным выходом помечена по другой причине: там продано
  // МЕНЬШЕ купленного, и «частично» правдиво. Её трогать нельзя.
  const CRO = { coin: 'CRO', pnl: 5.31, pnlPct: 0.21, costTotal: 2491.03, holdH: 177,
    partial: true, unknownExit: true, unknownCost: 1197.5, entryAt: 1, closedAt: 2,
    buys: [{ orderId: 'b1', price: 0.06, size: 41421.9, usd: 2491.03, t: 1 }],
    sells: [{ orderId: 's1', price: 0.0605, size: 21516.2, usd: 1301.62, pnl: 5.31, t: 2 }] };
  const ctx2 = load([CRO]);
  ok(ctx2.journal.closed[0].partial === true, 'у записи с неизвестным выходом пометка остаётся');
  ok(ctx2.saved === undefined, 'и файл ради неё не переписывается');

  // Чистка не должна идти по кругу: она пишет в файл
  ok(ctx.unmark() === 0, 'второй проход уже нечего снимать');
}

console.log('\nПочинка вызывается при загрузке');
ok(/\njournalRepairClosed\(\);/.test(src), 'разовый пересчёт стоит рядом с чтением файла');

console.log('\nПометка видна в обеих вёрстках');
// Исправленное число без объяснения выглядит как другая ошибка: у сделки с
// ходом цены +4% стоит +3.75% при продаже на $3785 — надо видеть, почему.
for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  const html = fs.readFileSync(file, 'utf8');
  ok(html.includes('${c.partial'), name + ': неполная запись помечена');
  ok(html.includes('Продано больше монет, чем журнал видел купленными'), name + ': и объяснено, что это значит');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
