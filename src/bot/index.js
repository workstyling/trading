// Торговый бот: настройки и разбивка баланса на сделки.
// Здесь только расчёт, без обращений к бирже. Стратегии пока нет, ордера бот
// не ставит.

const DEFAULT_CONFIG = Object.freeze({ coin: 'BTC', maxDeals: 2, maxUsd: 500 });
const MIN_DEAL_USD = 1;
const MAX_DEALS = 100;
const TEST_BALANCE_USD = 2000;

// Считаем в центах и округляем вниз: сумма сделок не должна превысить баланс.
// Поправка 1e-6 нужна из-за плавающей точки: 19.99 * 100 = 1998.9999999999998.
const toCents = (usd) => Math.floor(usd * 100 + 1e-6);

// Разбивка баланса: каждая сделка не больше maxUsd, всего не больше maxDeals.
// 600 при лимите 500 и двух сделках дают [500, 100].
// null значит «неизвестно»: без баланса разбивки нет, и это не то же, что
// пустой массив (деньги известны, но их не хватает на минимальную сделку).
function planDeals(balance, maxDeals, maxUsd) {
  if (!Number.isFinite(balance) || balance < 0) return null;
  if (!Number.isInteger(maxDeals) || maxDeals < 1) return null;
  if (!Number.isFinite(maxUsd) || maxUsd < MIN_DEAL_USD) return null;

  const minCents = toCents(MIN_DEAL_USD);
  const capCents = toCents(maxUsd);
  let leftCents = toCents(balance);
  const deals = [];
  while (deals.length < maxDeals && leftCents >= minCents) {
    const dealCents = Math.min(leftCents, capCents);
    deals.push(dealCents / 100);
    leftCents -= dealCents;
  }
  return deals;
}

// Проверка настроек. Возвращает { config } или { error }.
function normalizeConfig(input) {
  const src = input || {};
  const coin = String(src.coin == null ? '' : src.coin).trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,15}$/.test(coin)) return { error: 'Некорректная валюта' };

  // Пустое поле не должно становиться нулём: Number('') === 0.
  const number = (v) => (v == null || v === '' ? NaN : Number(v));

  const maxDeals = number(src.maxDeals);
  if (!Number.isInteger(maxDeals) || maxDeals < 1 || maxDeals > MAX_DEALS) {
    return { error: 'Количество сделок: целое число от 1 до ' + MAX_DEALS };
  }
  const maxUsd = number(src.maxUsd);
  if (!Number.isFinite(maxUsd) || maxUsd < MIN_DEAL_USD) {
    return { error: 'Сумма сделки: не меньше $' + MIN_DEAL_USD };
  }
  return { config: { coin, maxDeals, maxUsd: toCents(maxUsd) / 100 } };
}

// Состояние из файла. Повреждённые настройки заменяем значениями по умолчанию.
function restoreState(saved) {
  const src = saved && typeof saved === 'object' ? saved : {};
  const { config } = normalizeConfig(src);
  return {
    // Реальный режим только по явной записи: всё остальное считается тестовым.
    mode: src.mode === 'real' ? 'real' : 'test',
    ...(config || DEFAULT_CONFIG),
    orders: Array.isArray(src.orders) ? src.orders : [],
    deals: Array.isArray(src.deals) ? src.deals : [],
    realizedNetUsd: Number.isFinite(src.realizedNetUsd) ? src.realizedNetUsd : 0,
    paidFeesUsd: Number.isFinite(src.paidFeesUsd) ? src.paidFeesUsd : 0,
    finishing: src.finishing === true,
    nextId: Number.isInteger(src.nextId) && src.nextId > 0 ? src.nextId : 1,
  };
}

// Рост цены, нужный, чтобы купить и продать в ноль с комиссией pct на каждой стороне.
const breakevenPct = (pct) => ((1 + pct / 100) / (1 - pct / 100) - 1) * 100;

// Комиссии круга «купил и продал». null — ставки неизвестны: считать их нулём нельзя.
function feeSummary(limitPct, marketPct) {
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100;
  if (!valid(limitPct) || !valid(marketPct)) return null;
  return {
    limitPct,
    marketPct,
    limitBreakevenPct: breakevenPct(limitPct),
    marketBreakevenPct: breakevenPct(marketPct),
  };
}

// Спред в процентах от середины. null — котировка неполная или неверная.
function spreadPct(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
  return ((ask - bid) / ((ask + bid) / 2)) * 100;
}

// Выбор типа ордера по цене исполнения. Market платит комиссию и половину
// спреда, Limit только свою комиссию, но может не исполниться: тогда сделки нет,
// и это безопаснее переплаты. Стоп всегда Market: он обязан исполниться.
// null — данных для сравнения нет.
function chooseOrderTypes(fees, spread) {
  if (!fees) return null;
  const spreadKnown = typeof spread === 'number' && Number.isFinite(spread) && spread >= 0;
  // Если Limit дороже по ставке, исход решает спред: без него сравнивать нечего.
  if (fees.limitPct > fees.marketPct && !spreadKnown) return null;
  const marketCostPct = fees.marketPct + (spreadKnown ? spread / 2 : 0);
  const passive = fees.limitPct <= marketCostPct ? 'limit' : 'market';
  return {
    entry: passive,
    takeProfit: passive,
    stopLoss: 'market',
    spreadKnown,
    savingPct: Math.abs(marketCostPct - fees.limitPct),
  };
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < values.length; i++) {
    if (i >= period) ema = values[i] * k + ema * (1 - k);
    out.push(i < period - 1 ? null : ema);
  }
  return out;
}

const DIRECTION_MIN_CANDLES = 60;
const DIRECTION_MAX_AGE_SEC = 3 * 3600;

// Текущий тренд по часовым свечам Coinbase [время, low, high, open, close, объём].
// Описывает то, что уже происходит, и прогнозом не является.
// null — данных мало или они устарели.
function trendDirection(candles, nowSec) {
  if (!Array.isArray(candles)) return null;
  const rows = candles
    .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[4]) && c[4] > 0)
    .sort((a, b) => a[0] - b[0]);
  if (rows.length < DIRECTION_MIN_CANDLES) return null;
  const lastAt = rows[rows.length - 1][0];
  if (!Number.isFinite(nowSec) || nowSec - lastAt > DIRECTION_MAX_AGE_SEC) return null;

  const closes = rows.map((c) => c[4]);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const n = closes.length - 1;
  const price = closes[n];
  let trend = 'sideways';
  if (price > ema20[n] && ema20[n] > ema50[n] && ema20[n] > ema20[n - 3]) trend = 'up';
  if (price < ema20[n] && ema20[n] < ema50[n] && ema20[n] < ema20[n - 3]) trend = 'down';

  const dayAgo = rows.filter((c) => c[0] <= lastAt - 24 * 3600).pop();
  return {
    trend,
    price,
    change24hPct: dayAgo ? (price / dayAgo[4] - 1) * 100 : null,
  };
}

module.exports = {
  DEFAULT_CONFIG, MIN_DEAL_USD, MAX_DEALS, TEST_BALANCE_USD,
  planDeals, normalizeConfig, restoreState, feeSummary, spreadPct, chooseOrderTypes, trendDirection,
};
