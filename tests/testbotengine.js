// Виртуальная торговля бота: вход, цель, стоп, выход по времени, Стоп и счёт профита.
const { restoreState, feeSummary, chooseOrderTypes, DEFAULT_CONFIG } = require('../src/bot');
const { PARAMS, targetPct, cashUsd, lockedUsd, nextEntryAt, dealViews, step, beginFinish, closeAll, clearJournal } = require('../src/bot/engine');

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
    maxDeals: 1, maxUsd: 500, ...over,
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
  ok(near(targetPct(feeSummary(0.1, 0.2)), feeSummary(0.1, 0.2).limitBreakevenPct + PARAMS.netTargetPct), 'ниже комиссия на большем объёме — ниже цель');

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
  const stopRow = byRole(s, 'stopLoss')[0];
  ok(stopRow.type === 'stopLimit' && stopRow.status === 'WAITING', 'стоп выставлен как Stop-Limit и ждёт цену');

  const at = (price, now) => ({ direction: null, quote: { bid: price, ask: price + 0.01, price, at: now } });
  const above = tick(s, deal.stopPrice + 0.5, T0 + 2000, { direction: null });
  ok(above.deals[0].stopTriggeredAt === undefined, 'выше цены стопа не срабатывает');

  const trig = tick(s, deal.stopPrice, T0 + 2000, at(deal.stopPrice, T0 + 2000));
  ok(trig.deals.length === 1 && trig.deals[0].stopTriggeredAt === T0 + 2000, 'на цене стопа срабатывает, но сделка ещё открыта');
  ok(byRole(trig, 'stopLoss')[0].status === 'OPEN', 'лимитка стопа работает');
  ok(byRole(trig, 'takeProfit')[0].status === 'CANCELLED', 'цель снята: монеты заняты лимиткой стопа');

  // Цена вернулась выше лимитки: исполнилась по Limit
  const back = tick(trig, deal.stopPrice + 0.01, T0 + 3000, at(deal.stopPrice + 0.01, T0 + 3000));
  const byLimit = byRole(back, 'stopLoss')[0];
  ok(back.deals.length === 0 && byLimit.status === 'FILLED' && byLimit.type === 'stopLimit', 'цена вернулась: исполнено по Stop-Limit');
  ok(near(byLimit.price, deal.stopPrice), 'по цене лимитки, а не по текущей');
  const proceeds = deal.size * deal.stopPrice;
  ok(near(byLimit.feeUsd, proceeds * 0.005), 'комиссия Limit 0.5%, а не Market 0.9%');
  ok(near(byLimit.netUsd, proceeds * (1 - 0.005) - 502.5, 1e-6) && byLimit.netUsd < 0, 'убыток считает обе комиссии', byLimit.netUsd);

  // Касание цены лимитку не исполняет
  const touch = tick(trig, deal.stopPrice, T0 + 3000, at(deal.stopPrice, T0 + 3000));
  ok(touch.deals.length === 1, 'цена только коснулась лимитки: сделка ждёт');

  // Цена ушла ещё ниже: Market
  const slip = deal.stopPrice * (1 - PARAMS.stopLimitMaxSlipPct / 100);
  const notYet = tick(trig, slip + 0.01, T0 + 3000, at(slip + 0.01, T0 + 3000));
  ok(notYet.deals.length === 1, 'выше предела падения ещё ждём лимитку');
  const fell = tick(trig, slip, T0 + 3000, at(slip, T0 + 3000));
  const byMarket = byRole(fell, 'stopLoss')[0];
  ok(fell.deals.length === 0 && byMarket.status === 'FILLED' && byMarket.type === 'market', 'цена ушла ниже предела: продажа по Market');
  ok(near(byMarket.price, slip) && near(byMarket.feeUsd, deal.size * slip * 0.009), 'по текущей цене, комиссия Market');

  // Лимитка стоит слишком долго: Market
  const inTime = tick(trig, deal.stopPrice - 0.5, T0 + 2000 + PARAMS.stopLimitTimeoutMs - 1, at(deal.stopPrice - 0.5, T0 + 2000 + PARAMS.stopLimitTimeoutMs - 1));
  ok(inTime.deals.length === 1, 'до конца времени ждём лимитку');
  const timedOut = tick(trig, deal.stopPrice - 0.5, T0 + 2000 + PARAMS.stopLimitTimeoutMs, at(deal.stopPrice - 0.5, T0 + 2000 + PARAMS.stopLimitTimeoutMs));
  ok(timedOut.deals.length === 0 && byRole(timedOut, 'stopLoss')[0].type === 'market', 'время вышло: продажа по Market');

  // После срабатывания цель больше не работает
  const late = tick(trig, deal.takeProfitPrice + 1, T0 + 3000, at(deal.takeProfitPrice + 1, T0 + 3000));
  const row = byRole(late, 'stopLoss')[0];
  ok(row.status === 'FILLED' && near(row.price, deal.stopPrice) && byRole(late, 'takeProfit')[0].status === 'CANCELLED', 'резкий отскок: исполняется лимитка стопа, а не снятая цель');

  // Сильный обвал за один шаг: сначала срабатывает, следующий шаг продаёт
  const crash = tick(tick(s, deal.stopPrice * 0.9, T0 + 2000, { direction: null }), deal.stopPrice * 0.9, T0 + 22000, { direction: null });
  ok(crash.deals.length === 0 && byRole(crash, 'stopLoss')[0].type === 'market', 'обвал: за два шага продано по Market');

  const paused = tick(tick(s, deal.stopPrice * 0.9, T0 + 2000, { status: 'paused', direction: null }), deal.stopPrice * 0.9, T0 + 22000, { status: 'paused', direction: null });
  ok(paused.deals.length === 0, 'на паузе стоп продолжает работать');

  // Стоп на время: сработавшая лимитка не продаётся по таймеру сделки раньше своего времени
  const longHold = { ...JSON.parse(JSON.stringify(trig)) };
  const atLimit = tick(longHold, deal.stopPrice, T0 + 2000 + 1000, at(deal.stopPrice, T0 + 3000));
  ok(!byRole(atLimit, 'timeExit').length, 'продажи по времени сделки у сработавшего стопа нет');

  const closed = closeAll(trig, quote(deal.stopPrice, T0 + 3000), T0 + 3000);
  ok(closed.deals.length === 0 && byRole(closed, 'stopButton').length === 1, 'кнопка «Остановить» закрывает и сработавший стоп');
  ok(byRole(closed, 'stopLoss')[0].status === 'CANCELLED' && byRole(closed, 'stopLoss')[0].filledAt === null, 'его лимитка снята, не исполнена');
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

console.log('\nРазмер и число сделок');
{
  // Случай владельца: лимит 4 сделки, а открывалась одна
  let s = tick(fresh(), 100, T0, { maxDeals: 4 });
  ok(s.deals.length === 4, 'все 4 места заняты сразу', s.deals.length);
  ok(s.deals.slice(0, 3).every((d) => d.usd === 500), 'первые три по $500');
  ok(lockedUsd(s) <= 2000 + 1e-9 && lockedUsd(s) > 1999.9, 'вместе с комиссиями весь баланс, но не больше', lockedUsd(s));
  s = tick(s, 100, T0 + 1000, { maxDeals: 4 });
  ok(s.deals.length === 4, 'больше лимита сделок не открывается');
  ok(new Set(s.deals.map((d) => d.id)).size === 4, 'у сделок разные номера');

  // Четыре по $500 с комиссиями стоят $2010: на четвёртую хватает только остатка
  const fourth = s.deals[3].usd;
  ok(fourth > 490 && fourth < 490.1, 'четвёртая на остаток, в минус баланс не уходит', fourth);
  const limited = tick({ ...fresh(), realizedNetUsd: -100 }, 100, T0, { maxDeals: 4 });
  ok(limited.deals[3].usd < fourth && lockedUsd(limited) <= 1900 + 1e-9, 'при меньшем балансе последняя ещё меньше', lockedUsd(limited));

  // Свободное место после прибыльного закрытия занимается сразу
  let one = holding();
  one = tick(one, one.deals[0].takeProfitPrice + 1, T0 + 3000);
  ok(one.deals.length === 1 && byRole(one, 'entry').length === 2, 'после цели новый вход сразу');

  // После стопа пауза
  let lost = holding();
  const stopped = lost.deals[0].stopPrice;
  lost = tick(lost, stopped * 0.9, T0 + 2500);
  ok(lost.deals.length === 1 && byRole(lost, 'entry').length === 1, 'сработавший стоп занимает место, новой покупки нет');
  lost = tick(lost, stopped * 0.9, T0 + 3000);
  ok(lost.deals.length === 0 && byRole(lost, 'stopLoss')[0].status === 'FILLED', 'после стопа новой покупки в том же шаге нет');
  ok(nextEntryAt(lost) === T0 + 3000 + PARAMS.entrySpacingMs, 'пауза считается от исполнения стопа');
  ok(tick(lost, 100, T0 + 3000 + PARAMS.entrySpacingMs - 1).deals.length === 0, 'до конца паузы бот ждёт');
  ok(tick(lost, 100, T0 + 3000 + PARAMS.entrySpacingMs).deals.length === 1, 'после паузы новый вход');

  // Снятая покупка держит паузу и для остальных мест
  let cancelled = tick(tick(fresh(), 100, T0, { maxDeals: 4 }), 100, T0 + PARAMS.entryTimeoutMs, { maxDeals: 4 });
  ok(cancelled.deals.length === 0 && byRole(cancelled, 'entry').length === 4, 'снятые покупки сразу не заменяются');

  // Баланс как в примере владельца: 600 при лимите 500
  const small = { ...fresh(), realizedNetUsd: -1400 };
  const a = tick(small, 100, T0, { maxDeals: 2 });
  ok(a.deals[0].usd === 500, 'первая сделка $500 из $600', a.deals[0].usd);
  const second = a.deals[1];
  ok(second && second.usd > 96 && second.usd < 97.5, 'вторая на остаток с запасом на комиссии', second && second.usd);
  ok(lockedUsd(a) <= 600 + 1e-9, 'вместе с комиссиями не больше баланса', lockedUsd(a));
  ok(tick(small, 100, T0, { maxDeals: 5 }).deals.length === 2, 'при лимите 5 лишних сделок на копейки нет');

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
  ok(row.stop.status === 'WAITING' && row.stop.type === 'stopLimit', 'стоп ждёт цену');
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

  const later = T0 + 3000 + PARAMS.entrySpacingMs;
  const crashed = tick(tick(s, s.deals[0].stopPrice * 0.9, T0 + 2500, { direction: null }), s.deals[0].stopPrice * 0.9, T0 + 3000, { direction: null });
  const twoPairs = tick(crashed, 100, later);
  const e = dealViews(twoPairs, quote(100, later), later);
  ok(e.closed.length === 1 && e.open.length === 1, 'закрытая и новая открытая сделка показаны раздельно');
}

console.log('\nОстановить и доделать');
{
  // Одна сделка куплена, вторая покупка ещё не исполнена
  let s = holding();
  const bought = s.deals[0];
  s.deals.push({ ...bought, id: 'D99', stage: 'entry', entryOrderId: 'T99', usd: 100, entryFeeUsd: 0.5 });
  s.orders.push({ id: 'T99', dealId: 'D99', role: 'entry', side: 'BUY', status: 'OPEN', at: T0, usd: 100, price: 99, pair: PAIR, type: 'limit', mode: 'test' });
  const before = JSON.stringify(s);
  const f = beginFinish(s, T0 + 5000);
  ok(JSON.stringify(s) === before, 'исходное состояние не изменено');
  ok(f.finishing === true, 'есть что доделывать');
  ok(f.deals.length === 1 && f.deals[0].stage === 'holding', 'неисполненная покупка снята, купленное осталось');
  ok(f.orders.find((o) => o.id === 'T99').status === 'CANCELLED', 'и она помечена снятой');
  ok(byRole(f, 'takeProfit')[0].status === 'OPEN', 'цель продолжает работать');

  const run = (state, price, now, over = {}) => tick(state, price, now, { status: 'finishing', ...over });
  const noNew = run(f, 100, T0 + 6000, { maxDeals: 4 });
  ok(noNew.deals.length === 1 && byRole(noNew, 'entry').length === 2, 'новых сделок нет, хотя направление вверх');

  const late = run(f, 100, bought.filledAt + PARAMS.maxHoldMs * 3);
  ok(late.deals.length === 1 && !byRole(late, 'timeExit').length, 'по времени в минус не продаёт, ждёт цель');

  const won = run(f, bought.takeProfitPrice + 1, T0 + 7000);
  ok(won.deals.length === 0 && won.realizedNetUsd > 0, 'цель закрывает сделку в плюс', won.realizedNetUsd);

  const lost = run(run(f, bought.stopPrice * 0.9, T0 + 7000), bought.stopPrice * 0.9, T0 + 8000);
  ok(lost.deals.length === 0 && lost.realizedNetUsd < 0, 'стоп продолжает ограничивать убыток', lost.realizedNetUsd);

  ok(beginFinish(tick(fresh(), 100, T0), T0 + 1000).finishing === false, 'только неисполненные покупки: доделывать нечего');
  ok(closeAll(f, quote(100, T0 + 8000), T0 + 8000).finishing === false, '«Остановить» отменяет доделывание');
  ok(clearJournal(f).finishing === false, 'новый прогон начинается без доделывания');
  const saved = restoreState(JSON.parse(JSON.stringify(f)));
  ok(saved.finishing === true && saved.deals.length === 1, 'доделывание переживает перезапуск');
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
  const low = again.deals[0].stopPrice * 0.5;
  const after = tick(tick(again, low, T0 + 3000, { direction: null }), low, T0 + 4000, { direction: null });
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
