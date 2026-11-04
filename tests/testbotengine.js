// Виртуальная торговля бота: вход, цель, стоп, выход по времени, Стоп и счёт профита.
const { restoreState, feeSummary, chooseOrderTypes, DEFAULT_CONFIG } = require('../src/bot');
const { PARAMS, targetPct, cashUsd, lockedUsd, nextEntryAt, dealViews, step, closeAll, clearJournal } = require('../src/bot/engine');

let bad = 0;
const ok = (cond, message, extra) => {
  if (!cond) bad++;
  console.log('  ' + (cond ? 'ok  ' : 'ПЛОХО') + '  ' + message + (cond || extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const PAIR = 'BTC-USD';
const T0 = 1800000000000;
const FEES = feeSummary(0.5, 0.9);
const fresh = () => restoreState({ ...DEFAULT_CONFIG });
const quote = (price, now, spread = 0.02) => ({ bid: price - spread / 2, ask: price + spread / 2, price, at: now });
const UP = { trend: 'up', price: 100, change24hPct: 1 };

function tick(state, price, now, over = {}) {
  const q = over.quote === undefined ? quote(price, now) : over.quote;
  const fees = over.fees === undefined ? FEES : over.fees;
  return step(state, {
    status: 'running', pair: PAIR, quote: q, now, direction: UP, fees,
    orderTypes: over.orderTypes === undefined ? chooseOrderTypes(fees, 0.01) : over.orderTypes,
    maxDeals: 2, maxUsd: 500, ...over,
  });
}
const byRole = (s, role) => s.orders.filter((o) => o.role === role);

// Сделка с исполненным входом ровно по 100
function holding() {
  let s = tick(fresh(), 100, T0, { quote: { bid: 100, ask: 100.02, price: 100.01, at: T0 } });
  s = tick(s, 99.99, T0 + 1000, { direction: null });
  return s;
}

console.log('\nВход');
{
  let s = tick(fresh(), 100, T0);
  const entry = byRole(s, 'entry')[0];
  ok(s.deals.length === 1 && entry && entry.status === 'OPEN', 'направление вверх: открыт ордер на вход', s);
  ok(entry.type === 'limit' && entry.side === 'BUY' && entry.mode === 'test', 'Limit на покупку, тестовый');
  ok(near(entry.price, 99.99) && entry.usd === 500, 'по bid на $500', entry);
  ok(s.orders.length === 1, 'пока вход не исполнен, цели и стопа нет');
  ok(lockedUsd(s) === 502.5 && cashUsd(s) === 2000, 'деньги с комиссией заняты, баланс не тронут', lockedUsd(s));

  s = tick(s, entry.price, T0 + 1000, { direction: null });
  ok(byRole(s, 'entry')[0].status === 'OPEN', 'касание цены лимитку не исполняет');
  s = tick(s, entry.price - 0.01, T0 + 2000, { direction: null });
  ok(byRole(s, 'entry')[0].status === 'FILLED', 'проход сквозь цену исполняет');
  ok(near(byRole(s, 'entry')[0].feeUsd, 2.5), 'комиссия входа по Limit 0.5% = $2.50');
  ok(byRole(s, 'entry')[0].price === entry.price, 'цена исполнения равна лимиту');
  ok(byRole(s, 'takeProfit').length === 1 && byRole(s, 'stopLoss').length === 1, 'появились цель и стоп');

  const down = tick(fresh(), 100, T0, { direction: { trend: 'down' } });
  ok(down.deals.length === 0, 'направление вниз: входа нет');
  const side = tick(fresh(), 100, T0, { direction: { trend: 'sideways' } });
  ok(side.deals.length === 0, 'боком: входа нет');
  ok(tick(fresh(), 100, T0, { direction: null }).deals.length === 0, 'направление неизвестно: входа нет');
  ok(tick(fresh(), 100, T0, { fees: null, orderTypes: null }).deals.length === 0, 'комиссии неизвестны: входа нет');
  ok(tick(fresh(), 100, T0, { orderTypes: null }).deals.length === 0, 'тип ордера не выбран: входа нет');
  ok(tick(fresh(), 100, T0, { status: 'paused' }).deals.length === 0, 'на паузе новых сделок нет');
  ok(tick(fresh(), 100, T0, { status: 'stopped' }).deals.length === 0, 'остановлен: сделок нет');
}

console.log('\nНеверная цена');
{
  for (const [name, q] of [['нет цены', null],
    ['устаревшая', { bid: 99, ask: 100, price: 99, at: T0 - PARAMS.quoteMaxAgeMs - 1 }],
    ['без времени', { bid: 99, ask: 100, price: 99, at: NaN }],
    ['bid больше ask', { bid: 101, ask: 100, price: 100, at: T0 }],
    ['нулевая', { bid: 0, ask: 0, price: 0, at: T0 }]]) {
    ok(tick(fresh(), 100, T0, { quote: q }).deals.length === 0, name + ': сделки не открываются');
    const h = holding();
    const after = tick(h, 1, T0 + 5000, { quote: q, direction: null });
    ok(after.deals.length === 1, name + ': открытая сделка не закрывается');
  }
}

console.log('\nОтмена входа');
{
  let s = tick(fresh(), 100, T0);
  s = tick(s, 100, T0 + PARAMS.entryTimeoutMs - 1, { direction: null });
  ok(s.deals.length === 1, 'до таймаута ордер висит');
  s = tick(s, 100, T0 + PARAMS.entryTimeoutMs, { direction: null });
  ok(s.deals.length === 0 && byRole(s, 'entry')[0].status === 'CANCELLED', 'по таймауту снят');
  ok(cashUsd(s) === 2000 && lockedUsd(s) === 0, 'неисполненный вход ничего не стоит');
  const cancelled = byRole(s, 'entry')[0];
  ok(cancelled.filledAt === null && cancelled.closedAt === T0 + PARAMS.entryTimeoutMs, 'снятый ордер не помечен исполненным', cancelled);
  ok(cancelled.feeUsd === null && s.paidFeesUsd === 0, 'и комиссии за него нет');

  // Направление всё время вверх: снятие и попытка нового входа в одном шаге
  const sameTick = tick(tick(fresh(), 100, T0), 100, T0 + PARAMS.entryTimeoutMs);
  ok(sameTick.deals.length === 0 && byRole(sameTick, 'entry').length === 1, 'после снятия новая покупка не ставится сразу', sameTick.orders);
  ok(nextEntryAt(sameTick) === T0 + PARAMS.entrySpacingMs, 'следующий вход через интервал от снятого');
  const waiting = tick(sameTick, 100, T0 + PARAMS.entrySpacingMs - 1);
  ok(waiting.deals.length === 0, 'до этого времени бот ждёт');
  const down = tick(sameTick, 100, T0 + PARAMS.entrySpacingMs, { direction: { trend: 'down' } });
  ok(down.deals.length === 0, 'время пришло, но направление не вверх: входа нет');
  const next = tick(sameTick, 105, T0 + PARAMS.entrySpacingMs);
  ok(next.deals.length === 1 && byRole(next, 'entry').length === 2, 'время пришло и направление вверх: новый вход');
  ok(near(next.deals[0].entryPrice, 104.99), 'по новой цене, а не по старой', next.deals[0].entryPrice);
  ok(nextEntryAt(fresh()) === 0, 'журнал пуст: ждать нечего');
}

console.log('\nЦель');
{
  const s = holding();
  const deal = s.deals[0];
  const tp = byRole(s, 'takeProfit')[0];
  ok(tp.type === 'limit' && tp.status === 'OPEN', 'цель выставлена как Limit');
  ok(near(deal.targetPct, FEES.limitBreakevenPct + PARAMS.netTargetPct), 'цель = выход в ноль по тарифу + чистая прибыль', deal.targetPct);
  ok(near(targetPct(feeSummary(0.1, 0.2), 'limit'), feeSummary(0.1, 0.2).limitBreakevenPct + PARAMS.netTargetPct), 'ниже комиссия на большем объёме — ниже цель');

  const touch = tick(s, deal.takeProfitPrice, T0 + 2000, { direction: null });
  ok(touch.deals.length === 1, 'касание цели не исполняет Limit');

  const won = tick(s, deal.takeProfitPrice + 0.01, T0 + 3000, { direction: null });
  const filled = byRole(won, 'takeProfit')[0];
  ok(won.deals.length === 0 && filled.status === 'FILLED', 'проход сквозь цель закрывает сделку');
  const expected = 500 * (PARAMS.netTargetPct / 100) * (1 - 0.005);
  ok(near(filled.netUsd, expected, 1e-6), 'чистый профит: заданный процент от $500 с поправкой на комиссию выхода', filled.netUsd);
  ok(near(won.realizedNetUsd, expected), 'профит попал в итог');
  ok(near(won.paidFeesUsd, 2.5 + filled.feeUsd), 'в итог комиссий попали обе стороны');
  ok(near(cashUsd(won), 2000 + expected), 'баланс вырос на чистый профит');
  ok(byRole(won, 'stopLoss')[0].status === 'CANCELLED', 'стоп снят');
  ok(lockedUsd(won) === 0, 'деньги освобождены');
}

console.log('\nСтоп');
{
  const s = holding();
  const deal = s.deals[0];
  const lost = tick(s, deal.stopPrice, T0 + 2000, { direction: null, quote: { bid: deal.stopPrice, ask: deal.stopPrice + 0.01, price: deal.stopPrice, at: T0 + 2000 } });
  const filled = byRole(lost, 'stopLoss')[0];
  ok(lost.deals.length === 0 && filled.status === 'FILLED' && filled.type === 'market', 'стоп закрывает по Market');
  const proceeds = deal.size * deal.stopPrice;
  const expected = proceeds * (1 - 0.009) - 500 - 2.5;
  ok(near(filled.netUsd, expected, 1e-6) && filled.netUsd < 0, 'убыток считает обе комиссии, выход по Market 0.9%', filled.netUsd);
  ok(near(filled.feeUsd, proceeds * 0.009), 'комиссия выхода по Market');
  ok(byRole(lost, 'takeProfit')[0].status === 'CANCELLED', 'цель снята');

  const gap = tick(s, deal.stopPrice * 0.9, T0 + 2000, { direction: null });
  ok(near(byRole(gap, 'stopLoss')[0].price, deal.stopPrice * 0.9 - 0.01), 'при обвале исполняется по текущей цене, не по цене стопа');

  const paused = tick(s, deal.stopPrice * 0.9, T0 + 2000, { status: 'paused', direction: null });
  ok(paused.deals.length === 0, 'на паузе стоп продолжает работать');
}

console.log('\nВыход по времени');
{
  const s = holding();
  const open = s.deals[0].filledAt;
  const before = tick(s, 100, open + PARAMS.maxHoldMs - 1, { direction: null });
  ok(before.deals.length === 1, 'до предела времени сделка держится');
  const after = tick(s, 100, open + PARAMS.maxHoldMs, { direction: null });
  const row = byRole(after, 'timeExit')[0];
  ok(after.deals.length === 0 && row && row.type === 'market' && row.status === 'FILLED', 'по пределу времени продажа по Market');
  ok(byRole(after, 'takeProfit')[0].status === 'CANCELLED' && byRole(after, 'stopLoss')[0].status === 'CANCELLED', 'цель и стоп сняты');
}

console.log('\nВход по Market');
{
  const types = { entry: 'market', takeProfit: 'market', stopLoss: 'market', spreadKnown: true, savingPct: 0 };
  const s = tick(fresh(), 100, T0, { orderTypes: types });
  const entry = byRole(s, 'entry')[0];
  ok(entry.status === 'FILLED' && entry.type === 'market', 'исполнен сразу');
  ok(near(entry.price, 100.01), 'по ask, с переплатой спреда');
  ok(near(entry.feeUsd, 4.5), 'комиссия Market 0.9% = $4.50');
  const tp = s.deals[0].takeProfitPrice;
  ok(byRole(s, 'takeProfit')[0].status === 'WAITING', 'цель ждёт цену');
  const won = tick(s, tp + 0.02, T0 + 1000, { orderTypes: types, direction: null });
  const filled = byRole(won, 'takeProfit')[0];
  ok(won.deals.length === 0 && near(filled.price, tp + 0.01), 'цель Market исполняется по bid');
}

console.log('\nРазмер и число сделок');
{
  let s = tick(fresh(), 100, T0);
  s = tick(s, 100, T0 + 1000, { direction: null, quote: quote(99, T0 + 1000) });
  s = tick(s, 100, T0 + PARAMS.entrySpacingMs - 1);
  ok(byRole(s, 'entry').length === 1, 'следующий вход не раньше чем через интервал после исполненного');
  s = tick(fresh(), 100, T0);
  s = tick(s, 100, T0 + 1000, { direction: null, quote: quote(99, T0 + 1000) });
  s = tick(s, 100, T0 + PARAMS.entrySpacingMs);
  ok(s.deals.length === 2, 'через интервал вторая сделка');
  s = tick(s, 100, T0 + 2 * PARAMS.entrySpacingMs);
  ok(s.deals.length === 2, 'больше лимита сделок не открывается');

  // Баланс как в примере владельца: 600 при лимите 500
  const small = { ...fresh(), realizedNetUsd: -1400 };
  let a = tick(small, 100, T0);
  ok(a.deals[0].usd === 500, 'первая сделка $500 из $600', a.deals[0].usd);
  a = tick(a, 100, T0 + 1000, { direction: null, quote: quote(99, T0 + 1000) });
  a = tick(a, 100, T0 + PARAMS.entrySpacingMs);
  const second = a.deals[1];
  ok(second && second.usd > 96 && second.usd < 97.5, 'вторая на остаток с запасом на комиссии', second && second.usd);
  ok(lockedUsd(a) <= 600 + 1e-9, 'вместе с комиссиями не больше баланса', lockedUsd(a));

  const empty = { ...fresh(), realizedNetUsd: -1999.5 };
  ok(tick(empty, 100, T0).deals.length === 0, 'остаток меньше минимальной сделки: входа нет');
}

console.log('\nКнопка Стоп');
{
  const entryOnly = tick(fresh(), 100, T0);
  const a = closeAll(entryOnly, null, T0 + 1000);
  ok(a && a.deals.length === 0 && byRole(a, 'entry')[0].status === 'CANCELLED', 'вход снимается и без цены');

  const s = holding();
  ok(closeAll(s, null, T0 + 2000) === null, 'позицию без цены закрыть нельзя: отказ');
  const stale = { bid: 100, ask: 100, price: 100, at: T0 - PARAMS.quoteMaxAgeMs };
  ok(closeAll(s, stale, T0 + 2000) === null, 'по устаревшей цене тоже');
  const b = closeAll(s, quote(101, T0 + 2000), T0 + 2000);
  const row = byRole(b, 'stopButton')[0];
  ok(b.deals.length === 0 && row.type === 'market' && row.status === 'FILLED', 'позиция закрыта по Market');
  ok(byRole(b, 'takeProfit')[0].status === 'CANCELLED' && byRole(b, 'stopLoss')[0].status === 'CANCELLED', 'цель и стоп сняты');
  ok(near(b.realizedNetUsd, row.netUsd), 'результат попал в итог');
  ok(b.orders.every((o) => o.status === 'FILLED' || o.status === 'CANCELLED'), 'открытых ордеров не осталось');
  ok(s.deals.length === 1, 'исходное состояние не изменено');
}

console.log('\nСделки парами');
{
  const waiting = tick(fresh(), 100, T0);
  const a = dealViews(waiting, quote(100, T0), T0);
  ok(a.open.length === 1 && a.closed.length === 0, 'неисполненная покупка: сделка открыта');
  ok(a.open[0].buy.status === 'OPEN' && a.open[0].target === null && a.open[0].stop === null, 'продажа ещё не работает');
  ok(a.open[0].nowNetUsd === null, 'продавать нечего: результата нет');
  ok(near(a.open[0].buyFeeUsd, 2.5), 'комиссия покупки известна заранее');

  const s = holding();
  const b = dealViews(s, quote(100, T0 + 2000), T0 + 2000);
  ok(b.open.length === 1 && b.closed.length === 0, 'исполненная покупка остаётся в открытых, пока не продана');
  const row = b.open[0];
  ok(row.buy.status === 'FILLED', 'покупка исполнена');
  ok(row.target.status === 'OPEN' && row.target.type === 'limit', 'цель работает');
  ok(row.stop.status === 'WAITING' && row.stop.type === 'market', 'стоп ждёт цену');
  const size = 500 / s.deals[0].entryPrice;
  const bid = 100 - 0.01;
  ok(near(row.nowNetUsd, size * bid * (1 - 0.009) - 502.5), 'результат сейчас: продажа по bid, Market, обе комиссии', row.nowNetUsd);
  ok(dealViews(s, null, T0 + 2000).open[0].nowNetUsd === null, 'без цены результат неизвестен');

  const won = tick(s, s.deals[0].takeProfitPrice + 1, T0 + 3000, { direction: null });
  const c = dealViews(won, quote(100, T0 + 3000), T0 + 3000);
  ok(c.open.length === 0 && c.closed.length === 1, 'после продажи сделка закрыта');
  const pair = c.closed[0];
  ok(pair.buy.side === 'BUY' && pair.sell.side === 'SELL' && pair.buy.dealId === pair.sell.dealId, 'покупка и продажа в одной паре');
  ok(pair.sell.role === 'takeProfit', 'продажа по цели, снятый стоп в пару не попал');
  ok(near(pair.feesUsd, pair.buy.feeUsd + pair.sell.feeUsd) && pair.buy.feeUsd > 0 && pair.sell.feeUsd > 0, 'комиссии обеих сторон сложены');
  ok(near(pair.netUsd, pair.sell.usd - pair.buy.usd - pair.feesUsd), 'чистый профит = продажа − покупка − комиссии', pair.netUsd);

  const gone = tick(tick(fresh(), 100, T0), 100, T0 + PARAMS.entryTimeoutMs, { direction: null });
  const d = dealViews(gone, quote(100, T0), T0);
  ok(d.closed.length === 0 && d.open.length === 0 && d.cancelledEntries === 1, 'снятый вход не сделка: только в счётчике');

  const old = { ...fresh(), orders: [{ id: 'T2', dealId: 'D1', role: 'entry', side: 'BUY', status: 'CANCELLED', filledAt: 123, at: 1 }] };
  ok(dealViews(old, null, T0).cancelledEntries === 1, 'старая запись снятого ордера с filledAt тоже не считается исполненной');
  ok(tick(old, 100, T0).deals.length === 1, 'и не мешает новому входу');

  const twoPairs = tick(tick(s, s.deals[0].stopPrice * 0.9, T0 + 3000, { direction: null }), 100, T0 + PARAMS.entrySpacingMs);
  const e = dealViews(twoPairs, quote(100, T0 + PARAMS.entrySpacingMs), T0 + PARAMS.entrySpacingMs);
  ok(e.closed.length === 1 && e.open.length === 1, 'закрытая и новая открытая сделка показаны раздельно');
}

console.log('\nНовый прогон');
{
  const s = holding();
  const closed = closeAll(s, quote(101, T0 + 2000), T0 + 2000);
  ok(closed.orders.length > 0 && closed.realizedNetUsd !== 0, 'после Стопа результат виден');
  const custom = { ...closed, mode: 'test', coin: 'ETH', maxDeals: 5, maxUsd: 100 };
  const clean = clearJournal(custom);
  ok(clean.orders.length === 0 && clean.deals.length === 0, 'журнал пуст');
  ok(clean.realizedNetUsd === 0 && clean.paidFeesUsd === 0, 'профит и комиссии обнулены');
  ok(cashUsd(clean) === 2000, 'баланс снова $2000');
  ok(clean.coin === 'ETH' && clean.maxDeals === 5 && clean.maxUsd === 100 && clean.mode === 'test', 'настройки и режим сохранены');
  const view = dealViews(clean, quote(100, T0), T0);
  ok(!view.open.length && !view.closed.length && view.cancelledEntries === 0, 'на экране пусто');
  ok(custom.orders.length > 0, 'исходное состояние не изменено');
  ok(tick(clean, 100, T0 + 3000).deals.length === 1, 'новый вход не ждёт интервала от прошлого прогона');
}

console.log('\nОстальное');
{
  const s = fresh();
  const before = JSON.stringify(s);
  tick(s, 100, T0);
  ok(JSON.stringify(s) === before, 'шаг не меняет исходное состояние');
  const again = restoreState(JSON.parse(JSON.stringify(holding())));
  ok(again.deals.length === 1 && again.nextId > 1, 'сделка переживает запись в файл');
  const after = tick(again, again.deals[0].stopPrice * 0.5, T0 + 3000, { direction: null });
  ok(after.deals.length === 0, 'и продолжает вестись после перезапуска');
  const ids = holding().orders.map((o) => o.id);
  ok(new Set(ids).size === ids.length, 'номера ордеров не повторяются');

  // Пары покупка + продажа: журнал режется только целыми сделками
  let many = holding();
  const liveIds = many.orders.map((o) => o.id);
  const oldPairs = [];
  for (let i = 0; i < PARAMS.maxKeptOrders; i++) {
    const dealId = 'OLD' + i;
    oldPairs.push({ id: 'B' + i, dealId, role: 'entry', side: 'BUY', status: 'FILLED', at: i, feeUsd: 1 });
    oldPairs.push({ id: 'S' + i, dealId, role: 'takeProfit', side: 'SELL', status: 'FILLED', at: i, filledAt: i, feeUsd: 1, netUsd: 1 });
  }
  many.orders = [...oldPairs, ...many.orders];
  many = tick(many, 100, T0 + 2000, { direction: null });
  const counts = new Map();
  many.orders.forEach((o) => counts.set(o.dealId, (counts.get(o.dealId) || 0) + 1));
  ok(many.orders.filter((o) => o.dealId !== many.deals[0].id).length <= PARAMS.maxKeptOrders, 'старые сделки обрезаются');
  ok(liveIds.every((id) => many.orders.some((o) => o.id === id)), 'открытая сделка не обрезается, включая исполненную покупку');
  ok([...counts].every(([id, n]) => id === many.deals[0].id || n === 2), 'от пары не остаётся половина');
  ok(!many.orders.some((o) => o.dealId === 'OLD0') && many.orders.some((o) => o.dealId === 'OLD' + (PARAMS.maxKeptOrders - 1)), 'обрезаются самые старые');
}

if (bad) { console.log('\nПЛОХО: ' + bad); process.exit(1); }
console.log('\nвсё зелено');
