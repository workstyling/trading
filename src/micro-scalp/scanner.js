/**
 * Fast scalp research scanner.
 *
 * This deliberately lives outside src/scalp/: changing its experimental rules
 * must never reset the 2–6 hour structural-gate cohort. It is paper-only and
 * never places orders; delivery of clearly-labelled Paper alerts lives in the
 * server layer.
 */

const { ema, rsiSeries } = require('../scalp');
const { STABLE } = require('../scalp/scanner');

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const MIN_VOLUME_USD = 2e6;
const MAX_SPREAD_PCT = 0.2;
const BTC_MAX_AGE_MS = 5 * 60 * 1000;

function round(value, decimals = 2) {
  const power = 10 ** decimals;
  return Number.isFinite(value) ? Math.round(value * power) / power : null;
}

async function fetchMicroSignals(coin) {
  let raw = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${CB}/products/${coin}-USD/candles?granularity=300`, H);
      if (response.status === 429) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      if (!response.ok) return null;
      raw = await response.json();
      break;
    } catch {
      await sleep(200 * (attempt + 1));
    }
  }
  if (!Array.isArray(raw)) return null;
  const candles = raw
    .filter(row => Array.isArray(row) && Number(row[4]) > 0)
    .map(row => ({ t: Number(row[0]), low: Number(row[1]), high: Number(row[2]), close: Number(row[4]), vol: Number(row[5]) }))
    .filter(row => Number.isFinite(row.t) && Number.isFinite(row.low) && Number.isFinite(row.high) &&
      Number.isFinite(row.close) && Number.isFinite(row.vol))
    .sort((left, right) => left.t - right.t);
  if (candles.length < 30) return null;

  const closes = candles.map(row => row.close);
  const last = candles.length - 1;
  const price = closes[last];
  const rsi = rsiSeries(closes, 14);
  const rsiNow = rsi[last];
  const rsiWindow = rsi.slice(Math.max(0, last - 6), last + 1).filter(Number.isFinite);
  const rsiMin30m = rsiWindow.length ? Math.min(...rsiWindow) : null;
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const high30m = Math.max(...candles.slice(Math.max(0, last - 6), last + 1).map(row => row.high));
  const pullbackPct = high30m > 0 ? (high30m - price) / high30m * 100 : null;
  const volumeWindow = candles.slice(Math.max(0, last - 13), last).map(row => row.vol);
  const averageVolume = volumeWindow.length
    ? volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length : 0;
  const volumeX = averageVolume > 0 ? candles[last].vol / averageVolume : null;

  return {
    price,
    rsi5: round(rsiNow, 1),
    rsiMin30m: round(rsiMin30m, 1),
    ema9,
    ema21,
    aboveEma9: Number.isFinite(ema9) && price > ema9,
    emaStack: Number.isFinite(ema9) && Number.isFinite(ema21) && ema9 > ema21,
    rsiRecovery: Number.isFinite(rsiNow) && Number.isFinite(rsiMin30m) &&
      rsiMin30m <= 45 && rsiNow >= 42 && rsiNow <= 65 && rsiNow >= rsiMin30m + 4,
    pullbackPct: round(pullbackPct, 2),
    pullbackOk: Number.isFinite(pullbackPct) && pullbackPct >= 0.1 && pullbackPct <= 1.5,
    volumeX: round(volumeX, 2),
    volumeOk: Number.isFinite(volumeX) && volumeX >= 0.8,
  };
}

function calcMicroScore(signal, vol24, spreadPct, regime) {
  if (!signal) return null;
  const liquid = Number.isFinite(vol24) && vol24 >= MIN_VOLUME_USD;
  const spreadKnown = Number.isFinite(spreadPct) && spreadPct >= 0;
  const spreadOk = spreadKnown && spreadPct <= MAX_SPREAD_PCT;
  const btcFresh = !!(regime && Number.isFinite(regime.at) && Date.now() >= regime.at &&
    Date.now() - regime.at <= BTC_MAX_AGE_MS);
  const btcOk = !!(btcFresh && regime.above);
  const trendOk = signal.aboveEma9 && signal.emaStack;
  const checks = [
    { k: 'Liquidity >= $2M', ok: liquid, v: '$' + Math.round((vol24 || 0) / 1e6 * 10) / 10 + 'M' },
    { k: 'Spread verified and <=0.20%', ok: spreadOk, v: spreadKnown ? round(spreadPct, 3) + '%' : 'no quote' },
    { k: 'Price above EMA9 and EMA9 above EMA21 (5m)', ok: trendOk, v: trendOk ? 'trend up' : 'not aligned' },
    { k: 'RSI 5m recovering from a 30m pullback', ok: signal.rsiRecovery,
      v: `${signal.rsi5 == null ? '—' : signal.rsi5} (low ${signal.rsiMin30m == null ? '—' : signal.rsiMin30m})` },
    { k: 'Pullback from 30m high is 0.10%–1.50%', ok: signal.pullbackOk,
      v: signal.pullbackPct == null ? '—' : signal.pullbackPct + '%' },
    { k: 'Current 5m volume >= 0.8x recent average', ok: signal.volumeOk,
      v: signal.volumeX == null ? '—' : signal.volumeX + 'x' },
    { k: 'BTC above EMA20 (1h), fresh reading', ok: btcOk,
      v: btcFresh && regime ? `${regime.distPct >= 0 ? '+' : ''}${regime.distPct}%` : 'no fresh BTC regime' },
  ];
  const passed = checks.filter(check => check.ok).length;
  const pass = passed === checks.length;
  let score = 0;
  if (liquid) score += 15;
  if (spreadOk) score += 20;
  if (signal.aboveEma9) score += 15;
  if (signal.emaStack) score += 15;
  if (signal.rsiRecovery) score += 15;
  if (signal.pullbackOk) score += 10;
  if (signal.volumeOk) score += 5;
  if (btcOk) score += 5;
  if (!pass) score = Math.min(score, 84);
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    pass,
    passed,
    checks,
    tag: pass ? 'PAPER SETUP' : passed === checks.length - 1 ? 'NEAR' : 'WATCH',
    rsi: signal.rsi5,
    pullbackPct: signal.pullbackPct,
    volumeX: signal.volumeX,
    spreadPct: spreadKnown ? round(spreadPct, 3) : null,
  };
}

async function fetchSpread(pair) {
  try {
    const response = await fetch(`${CB}/products/${pair}/ticker`, H);
    if (!response.ok) return null;
    const ticker = await response.json();
    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);
    if (!(bid > 0) || !(ask > 0) || bid > ask) return null;
    return (ask - bid) / ((ask + bid) / 2) * 100;
  } catch {
    return null;
  }
}

async function scanMarket(volumeCache, regime, options = {}) {
  const maxCoins = options.maxCoins || 30;
  const onProgress = options.onProgress || (() => {});
  const universe = [...volumeCache.entries()]
    .map(([coin, volume]) => ({ coin, volume: Number(volume) || 0 }))
    .filter(item => item.volume >= MIN_VOLUME_USD && !STABLE.has(item.coin))
    .sort((left, right) => right.volume - left.volume)
    .slice(0, maxCoins);
  const results = [];
  let scanned = 0;

  for (let index = 0; index < universe.length; index += 3) {
    const batch = universe.slice(index, index + 3);
    await Promise.all(batch.map(async ({ coin, volume }) => {
      const signal = await fetchMicroSignals(coin);
      if (!signal) return;
      // Спред меряем у ВСЕХ просканированных пар, а не только у кандидатов.
      // Экономия одного запроса стоила правды в таблице: спред оставался
      // неизмеренным у 14 строк из 15, и колонка готовности занижала их все,
      // показывая «условие не выполнено» там, где оно просто не проверялось.
      // На отбор это не влияет — пара, не прошедшая тренд, RSI или откат, всё
      // равно не станет входом, — но теперь видно её настоящее расстояние.
      const spread = await fetchSpread(`${coin}-USD`);
      const score = calcMicroScore(signal, volume, spread, regime);
      if (score) results.push({ coin, pair: `${coin}-USD`, price: signal.price, vol24: volume, ...score });
    }));
    scanned += batch.length;
    onProgress(scanned, universe.length);
    // Запросов на пару стало два вместо одного, поэтому пауза между пачками ощутимо
    // длиннее: у Coinbase 10 запросов в секунду на адрес, и рядом работает
    // сканер структурного гейта. Проход тридцати пар всё равно укладывается
    // в несколько секунд при цикле в две минуты.
    await sleep(500);
  }
  results.sort((left, right) => right.score - left.score || left.coin.localeCompare(right.coin));
  return { results, total: universe.length, at: Date.now() };
}

module.exports = {
  MIN_VOLUME_USD,
  MAX_SPREAD_PCT,
  BTC_MAX_AGE_MS,
  fetchMicroSignals,
  calcMicroScore,
  scanMarket,
};
