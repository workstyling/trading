// Виртуальная торговля бота на тестовом балансе. Биржи здесь нет: цены приходят
// снаружи, реальные ордера не ставятся. Каждый шаг получает состояние и рынок и
// возвращает новое состояние, поэтому логику можно проверить без сервера.
const { MIN_DEAL_USD, TEST_BALANCE_USD } = require('./index');

const PARAMS = Object.freeze({
  netTargetPct: 0.5,                 // чистыми после комиссий обоих концов
  stopLossPct: 2,                    // от цены входа, до комиссий
  entryTimeoutMs: 10 * 60 * 1000,
  maxHoldMs: 24 * 3600 * 1000,
  entrySpacingMs: 15 * 60 * 1000,    // пауза после снятого входа и после стопа
  quoteMaxAgeMs: 5 * 60 * 1000,
  maxKeptOrders: 500,
});

const rateOf = (fees, type) => (type === 'limit' ? fees.limitPct : fees.marketPct);

// Цель сделки в процентах: выход в ноль по текущему тарифу плюс чистая прибыль.
// Снизится комиссия с ростом объёма за 30 дней — снизится и цель.
function targetPct(fees, exitType) {
  return (exitType === 'limit' ? fees.limitBreakevenPct : fees.marketBreakevenPct) + PARAMS.netTargetPct;
}

function validQuote(quote, now) {
  return !!quote && quote.bid > 0 && quote.ask >= quote.bid && quote.price > 0 &&
    Number.isFinite(quote.at) && now - quote.at <= PARAMS.quoteMaxAgeMs;
}

const cashUsd = (state) => TEST_BALANCE_USD + state.realizedNetUsd;
const lockedUsd = (state) => state.deals.reduce((sum, d) => sum + d.usd + d.entryFeeUsd, 0);

function addOrder(state, fields) {
  const order = { id: 'T' + state.nextId++, mode: 'test', feeUsd: null, netUsd: null, filledAt: null, closedAt: null, ...fields };
  state.orders.push(order);
  return order;
}

const orderById = (state, id) => state.orders.find((o) => o.id === id);

function fillEntry(state, deal, price, now) {
  const order = orderById(state, deal.entryOrderId);
  order.status = 'FILLED';
  order.filledAt = now;
  order.price = price;
  order.feeUsd = deal.entryFeeUsd;
  deal.stage = 'holding';
  deal.entryPrice = price;
  deal.filledAt = now;
  deal.size = deal.usd / price;
  deal.takeProfitPrice = price * (1 + deal.targetPct / 100);
  deal.stopPrice = price * (1 - PARAMS.stopLossPct / 100);
  const common = { dealId: deal.id, at: now, pair: deal.pair, side: 'SELL', usd: deal.usd, status: 'WAITING' };
  deal.takeProfitOrderId = addOrder(state, {
    ...common, type: deal.exitType, role: 'takeProfit', price: deal.takeProfitPrice,
    status: deal.exitType === 'limit' ? 'OPEN' : 'WAITING',
  }).id;
  deal.stopOrderId = addOrder(state, { ...common, type: 'market', role: 'stopLoss', price: deal.stopPrice }).id;
}

// Чистый результат продажи: минус комиссия покупки и комиссия продажи.
function netOfSale(deal, price, ratePct) {
  const proceeds = deal.size * price;
  const feeUsd = proceeds * ratePct / 100;
  return { proceeds, feeUsd, netUsd: proceeds - feeUsd - deal.usd - deal.entryFeeUsd };
}

function closeDeal(state, deal, { price, ratePct, now, filledOrderId, type, role }) {
  const { proceeds, feeUsd, netUsd } = netOfSale(deal, price, ratePct);
  for (const id of [deal.takeProfitOrderId, deal.stopOrderId]) {
    if (id !== filledOrderId) {
      const order = orderById(state, id);
      order.status = 'CANCELLED';
      order.closedAt = now;
    }
  }
  const fields = { status: 'FILLED', filledAt: now, price, usd: proceeds, feeUsd, netUsd };
  if (filledOrderId) Object.assign(orderById(state, filledOrderId), fields);
  else addOrder(state, { dealId: deal.id, at: now, pair: deal.pair, side: 'SELL', type, role, ...fields });
  state.realizedNetUsd += netUsd;
  state.paidFeesUsd += deal.entryFeeUsd + feeUsd;
  state.deals = state.deals.filter((d) => d !== deal);
}

// Снятый ордер не исполнялся: filledAt остаётся пустым, денег и комиссий нет.
function cancelEntry(state, deal, now) {
  const order = orderById(state, deal.entryOrderId);
  order.status = 'CANCELLED';
  order.closedAt = now;
  state.deals = state.deals.filter((d) => d !== deal);
}

function manageDeal(state, deal, quote, now, status) {
  if (deal.stage === 'entry') {
    // Лимитка исполнена, только если цена прошла сквозь неё, а не коснулась:
    // на касании очередь могла не дойти.
    if (quote.price < deal.entryPrice) fillEntry(state, deal, deal.entryPrice, now);
    else if (now - deal.placedAt >= PARAMS.entryTimeoutMs) cancelEntry(state, deal, now);
    return;
  }
  // Стоп проверяем первым: при сомнении считаем исход худшим.
  if (quote.bid <= deal.stopPrice) {
    closeDeal(state, deal, { price: quote.bid, ratePct: deal.marketPct, now, filledOrderId: deal.stopOrderId });
  } else if (deal.exitType === 'limit' && quote.price > deal.takeProfitPrice) {
    closeDeal(state, deal, { price: deal.takeProfitPrice, ratePct: deal.limitPct, now, filledOrderId: deal.takeProfitOrderId });
  } else if (deal.exitType === 'market' && quote.bid >= deal.takeProfitPrice) {
    closeDeal(state, deal, { price: quote.bid, ratePct: deal.marketPct, now, filledOrderId: deal.takeProfitOrderId });
  } else if (status !== 'finishing' && now - deal.filledAt >= PARAMS.maxHoldMs) {
    // При доделывании по времени не продаём: сделка ждёт цель, а стоп ограничивает убыток.
    closeDeal(state, deal, { price: quote.bid, ratePct: deal.marketPct, now, type: 'market', role: 'timeExit' });
  }
}

// Свободные места занимаются сразу. Ждать надо только после неудачи: после снятого
// входа, чтобы не ставить такую же покупку, и после стопа, чтобы не докупать в
// падение. Старт после Стопа очищает журнал и ждать не заставляет.
function nextEntryAt(state) {
  const last = state.orders.reduce((latest, o) => {
    if (o.role === 'entry' && o.status === 'CANCELLED') return Math.max(latest, o.at);
    if (o.role === 'stopLoss' && o.status === 'FILLED') return Math.max(latest, o.filledAt);
    return latest;
  }, 0);
  return last ? last + PARAMS.entrySpacingMs : 0;
}

function tryOpenDeal(state, { pair, quote, now, direction, fees, orderTypes, maxDeals, maxUsd }) {
  if (!direction || direction.trend !== 'up' || !fees || !orderTypes) return;
  if (state.deals.length >= maxDeals || now < nextEntryAt(state)) return;
  const type = orderTypes.entry;
  const ratePct = rateOf(fees, type);
  const free = cashUsd(state) - lockedUsd(state);
  const usd = Math.floor(Math.min(maxUsd, free / (1 + ratePct / 100)) * 100) / 100;
  if (usd < MIN_DEAL_USD) return;
  const price = type === 'limit' ? quote.bid : quote.ask;
  const dealId = 'D' + state.nextId++;
  const order = addOrder(state, {
    dealId, at: now, pair, side: 'BUY', type, role: 'entry', price, usd, status: 'OPEN',
  });
  const deal = {
    id: dealId, pair, stage: 'entry', usd, placedAt: now, entryPrice: price,
    entryFeeUsd: usd * ratePct / 100, entryOrderId: order.id,
    exitType: orderTypes.takeProfit, targetPct: targetPct(fees, orderTypes.takeProfit),
    limitPct: fees.limitPct, marketPct: fees.marketPct,
  };
  state.deals.push(deal);
  if (type === 'market') fillEntry(state, deal, price, now);
  return true;
}

// Режем журнал целыми сделками, старые первыми: иначе от пары осталась бы половина.
function trimOrders(state) {
  const activeDeals = new Set(state.deals.map((d) => d.id));
  const finished = state.orders.filter((o) => !activeDeals.has(o.dealId));
  let excess = finished.length - PARAMS.maxKeptOrders;
  if (excess <= 0) return;
  const dropped = new Set();
  for (const order of finished) {
    if (excess <= 0) break;
    if (dropped.has(order.dealId)) continue;
    dropped.add(order.dealId);
    excess -= finished.filter((o) => o.dealId === order.dealId).length;
  }
  state.orders = state.orders.filter((o) => !dropped.has(o.dealId));
}

// Ордера, собранные в сделки: покупка в паре с продажей. Снятый вход сделкой не
// был, поэтому только считается. nowNetUsd — чистыми, если продать сейчас по Market.
function dealViews(state, quote, now) {
  const groups = new Map();
  for (const order of state.orders) {
    if (!groups.has(order.dealId)) groups.set(order.dealId, []);
    groups.get(order.dealId).push(order);
  }
  const open = [];
  const closed = [];
  let cancelledEntries = 0;
  for (const [id, orders] of groups) {
    const buy = orders.find((o) => o.role === 'entry');
    if (!buy) continue;
    if (buy.status === 'CANCELLED') { cancelledEntries++; continue; }
    const deal = state.deals.find((d) => d.id === id);
    if (deal) {
      open.push({
        id,
        pair: buy.pair,
        buy,
        buyFeeUsd: deal.entryFeeUsd,
        target: orders.find((o) => o.role === 'takeProfit') || null,
        stop: orders.find((o) => o.role === 'stopLoss') || null,
        nowNetUsd: deal.stage === 'holding' && validQuote(quote, now)
          ? netOfSale(deal, quote.bid, deal.marketPct).netUsd : null,
      });
      continue;
    }
    const sell = orders.find((o) => o.side === 'SELL' && o.status === 'FILLED');
    if (!sell) continue;
    closed.push({
      id, pair: buy.pair, buy, sell,
      feesUsd: buy.feeUsd + sell.feeUsd,
      netUsd: sell.netUsd,
      closedAt: sell.filledAt,
    });
  }
  return {
    open: open.reverse(),
    closed: closed.sort((a, b) => b.closedAt - a.closedAt).slice(0, 50),
    cancelledEntries,
  };
}

// Один шаг. status running открывает сделки, paused только ведёт уже открытые.
// Неполные или устаревшие данные: шаг ничего не делает.
function step(state, market) {
  const next = JSON.parse(JSON.stringify(state));
  const { quote, now, status } = market;
  if (status === 'stopped' || !validQuote(quote, now)) return next;
  for (const deal of [...next.deals]) {
    if (deal.pair === market.pair) manageDeal(next, deal, quote, now, status);
  }
  // Каждая сделка занимает место и деньги, поэтому цикл ограничен лимитом и балансом.
  if (status === 'running') {
    while (tryOpenDeal(next, { ...market, quote, now }));
  }
  trimOrders(next);
  return next;
}

// Кнопка «Остановить и доделать»: неисполненные покупки снимаются, купленное
// доводится до цели или стопа. Когда сделок не останется, бот остановится сам.
function beginFinish(state, now) {
  const next = JSON.parse(JSON.stringify(state));
  for (const deal of [...next.deals]) {
    if (deal.stage === 'entry') cancelEntry(next, deal, now);
  }
  next.finishing = next.deals.length > 0;
  return next;
}

// Кнопка «Остановить»: снимает ордера и закрывает позиции по Market.
// Без цены позицию закрыть нечем: возвращаем null, и бот не останавливается.
function closeAll(state, quote, now) {
  const next = JSON.parse(JSON.stringify(state));
  const holding = next.deals.some((d) => d.stage === 'holding');
  if (holding && !validQuote(quote, now)) return null;
  next.finishing = false;
  for (const deal of [...next.deals]) {
    if (deal.stage === 'entry') cancelEntry(next, deal, now);
    else closeDeal(next, deal, { price: quote.bid, ratePct: deal.marketPct, now, type: 'market', role: 'stopButton' });
  }
  trimOrders(next);
  return next;
}

// Новый тестовый прогон: журнал пуст, баланс начальный, настройки и режим те же.
function clearJournal(state) {
  return { ...state, orders: [], deals: [], realizedNetUsd: 0, paidFeesUsd: 0, nextId: 1, finishing: false };
}

module.exports = { PARAMS, targetPct, validQuote, cashUsd, lockedUsd, nextEntryAt, dealViews, step, beginFinish, closeAll, clearJournal };
