'use strict';

/**
 * Reproducible historical check for the structural scalp gate.
 *
 * Usage: node src/scalp/validate-gate.js [days=7] [minVolume=500000] [maxCoins=110]
 *
 * The live spread check cannot be replayed from OHLCV history because Coinbase
 * does not expose historical bid/ask snapshots. This tool therefore reports a
 * structural result and writes its assumptions beside every result.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const DAY = 86400;
const FIVE_MIN_MS = 5 * 60 * 1000;
const BARS_PER_DAY = 288;
const MAX_HOLD_BARS = 48 * 12;
const COOLDOWN_BARS = 4 * 12;
const DAYS = positiveInt(process.argv[2], 7);
const MIN_VOL = positiveNumber(process.argv[3], 500e3);
const MAX_COINS = positiveInt(process.argv[4], 110);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const STABLE = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'GUSD', 'USDP', 'FRAX', 'LUSD',
  'CRVUSD', 'PYUSD', 'EURC', 'FDUSD', 'USDS', 'USDM', 'SUSD', 'DOLA', 'RAI',
  'EUR', 'GBP', 'CBETH', 'PAXG', 'WBTC',
]);

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveNumber(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function round(value, digits = 3) {
  const p = 10 ** digits;
  return Number.isFinite(value) ? Math.round(value * p) / p : null;
}

function configuredExit() {
  let paper = {};
  let settings = {};
  try { paper = JSON.parse(fs.readFileSync(path.join(ROOT, 'paper-trades.json'), 'utf8')); } catch { }
  try { settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'settings.json'), 'utf8')); } catch { }
  const targetPct = Number.isFinite(Number(paper.targetPct)) ? Number(paper.targetPct) : 2;
  const slPct = Number.isFinite(Number(paper.slPct)) ? Number(paper.slPct) : 6;
  const feeSidePct = Number.isFinite(Number(settings.tradeFee)) ? Number(settings.tradeFee) : 0.06;
  return { targetPct, slPct, feeSidePct: Math.max(0, feeSidePct) };
}

function gateFingerprint() {
  try {
    const src = ['src/scalp/index.js', 'src/scalp/scanner.js']
      .map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
    const logic = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha1').update(logic).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

async function fetchJson(url, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(url, H);
      if (response.status === 429) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (!response.ok) return null;
      return await response.json();
    } catch {
      await sleep(250 * (attempt + 1));
    }
  }
  return null;
}

async function fetch5m(coin, days, endMs) {
  const pages = Math.ceil(days * BARS_PER_DAY / 300) + 1;
  const candles = new Map();
  let end = endMs;
  for (let page = 0; page < pages; page++) {
    const start = end - 300 * FIVE_MIN_MS;
    const url = `${CB}/products/${coin}-USD/candles?granularity=300&start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end).toISOString())}`;
    const raw = await fetchJson(url);
    if (!Array.isArray(raw) || !raw.length) break;
    for (const row of raw) {
      if (!Array.isArray(row) || !(row[4] > 0)) continue;
      candles.set(row[0], { t: row[0], low: row[1], high: row[2], open: row[3], close: row[4], vol: row[5] });
    }
    end = start;
    await sleep(110);
  }
  return [...candles.values()].sort((a, b) => a.t - b.t);
}

async function fetchDaily(coin) {
  const raw = await fetchJson(`${CB}/products/${coin}-USD/candles?granularity=86400`);
  if (!Array.isArray(raw)) return new Map();
  return new Map(raw
    .filter(row => Array.isArray(row) && row[2] > 0)
    .map(row => [row[0], { high: row[2], close: row[4] }]));
}

async function loadUniverse() {
  const products = await fetchJson(`${CB}/products`);
  const pairs = (Array.isArray(products) ? products : [])
    .filter(product => product.quote_currency === 'USD' && product.status === 'online' && !product.trading_disabled)
    .map(product => product.base_currency)
    .filter(coin => !STABLE.has(coin));
  const universe = [];
  for (let offset = 0; offset < pairs.length; offset += 20) {
    const batch = await Promise.all(pairs.slice(offset, offset + 20).map(async coin => {
      const stats = await fetchJson(`${CB}/products/${coin}-USD/stats`, 1);
      if (!stats) return null;
      const volume = (Number(stats.volume) || 0) * (Number(stats.last) || 0);
      return volume >= MIN_VOL ? { coin, volume } : null;
    }));
    universe.push(...batch.filter(Boolean));
    await sleep(150);
  }
  return universe.sort((a, b) => b.volume - a.volume).slice(0, MAX_COINS);
}

function buildBtcFeatures(candles) {
  const features = new Map();
  const hourlySeed = [];
  let completedEma = null;
  let hour = null;
  let hourClose = null;
  const k = 2 / 21;
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const nextHour = Math.floor(candle.t / 3600) * 3600;
    if (hour != null && nextHour !== hour) {
      if (completedEma == null) {
        hourlySeed.push(hourClose);
        if (hourlySeed.length === 20) completedEma = hourlySeed.reduce((sum, value) => sum + value, 0) / 20;
      } else {
        completedEma = hourClose * k + completedEma * (1 - k);
      }
    }
    hour = nextHour;
    hourClose = candle.close;
    const currentHourEma = completedEma == null ? null : candle.close * k + completedEma * (1 - k);
    const weekBase = i >= 7 * BARS_PER_DAY ? candles[i - 7 * BARS_PER_DAY].close : null;
    const weekRetRaw = weekBase > 0 ? (candle.close / weekBase - 1) * 100 : null;
    const weekRetPct = round(weekRetRaw, 1);
    features.set(candle.t, {
      aboveEma20h: currentHourEma != null && candle.close > currentHourEma,
      weekPositive: weekRetPct != null && weekRetPct > 0,
      weekRetPct,
    });
  }
  return features;
}

function high14At(daily, dayStart, intradayHigh) {
  let high = intradayHigh;
  for (let offset = 1; offset <= 14; offset++) {
    const candle = daily.get(dayStart - offset * DAY);
    if (!candle || !(candle.high > 0)) return null;
    high = Math.max(high, candle.high);
  }
  return high > 0 ? high : null;
}

function contextAt(candles, index, closes, rsi, ema9, daily, dayHigh, btc, volume) {
  if (index < 288) return null;
  const price = closes[index];
  const range = candles.slice(index - 48, index + 1);
  const low = Math.min(...range.map(candle => candle.low));
  const high = Math.max(...range.map(candle => candle.high));
  const rangePosRaw = high > low ? (price - low) / (high - low) : 0.5;
  const range4Raw = low > 0 ? (high - low) / low * 100 : null;
  const dropFromHigh4Raw = high > 0 ? (high - price) / high * 100 : null;
  const rangePos = round(rangePosRaw, 2);
  const range4Pct = round(range4Raw, 1);
  const dropFromHigh4Pct = round(dropFromHigh4Raw, 2);
  const rsiWindow = rsi.slice(index - 12, index + 1).filter(Number.isFinite);
  const rsiMin = rsiWindow.length ? Math.min(...rsiWindow) : null;
  const rsiNow = rsi[index];
  const rsiRecover = rsiMin != null && Number.isFinite(rsiNow) && rsiMin < 30 && rsiNow > rsiMin + 3;
  const runUp24Raw = closes[index - 288] > 0 ? (closes[index - 48] / closes[index - 288] - 1) * 100 : null;
  const runUp24 = round(runUp24Raw, 1);
  const high14 = high14At(daily, Math.floor(candles[index].t / DAY) * DAY, dayHigh);
  const fromHigh14Raw = high14 ? (price / high14 - 1) * 100 : null;
  const fromHigh14 = round(fromHigh14Raw, 1);
  const regime = btc.get(candles[index].t);
  const checks = {
    bottom: rangePos < 0.25,
    rsiRecover,
    aboveEma9: ema9[index] != null && price > ema9[index],
    narrowRange: range4Pct != null && range4Pct < 8,
    notPumped: runUp24 != null && runUp24 <= 15,
    nearHigh14: fromHigh14 != null && fromHigh14 >= -10,
    liquid: volume >= MIN_VOL,
    btcAbove: !!(regime && regime.aboveEma20h),
    btcWeekPositive: !!(regime && regime.weekPositive),
  };
  return {
    pass: Object.values(checks).every(Boolean), checks,
    rsi: round(rsiNow, 1), rsiMin: round(rsiMin, 1),
    rangePos, range4Pct, dropFromHigh4Pct,
    runUp24, fromHigh14, btcWeekRetPct: regime ? regime.weekRetPct : null,
  };
}

function netPnlPct(entry, exit, feeSidePct) {
  const fee = feeSidePct / 100;
  return ((1 - fee) * (exit / entry) * (1 - fee) - 1) * 100;
}

function simulate(candles, index, exitCfg) {
  const entry = candles[index].close;
  const target = entry * (1 + exitCfg.targetPct / 100);
  const stop = exitCfg.slPct > 0 ? entry * (1 - exitCfg.slPct / 100) : 0;
  const last = Math.min(index + MAX_HOLD_BARS, candles.length - 1);
  for (let cursor = index + 1; cursor <= last; cursor++) {
    const candle = candles[cursor];
    // OHLC does not preserve intrabar order. Stop wins a double-touch so the
    // result is conservative instead of flattering.
    if (stop > 0 && candle.low <= stop) return { pnlPct: netPnlPct(entry, stop, exitCfg.feeSidePct), why: 'SL', bars: cursor - index };
    if (candle.high >= target) return { pnlPct: netPnlPct(entry, target, exitCfg.feeSidePct), why: 'TP', bars: cursor - index };
  }
  return { pnlPct: netPnlPct(entry, candles[last].close, exitCfg.feeSidePct), why: 'TIME', bars: last - index };
}

function metrics(rows) {
  if (!rows.length) return { n: 0, winRate: null, avgPct: null, profitFactor: null, tp: 0, sl: 0, time: 0 };
  const positives = rows.filter(row => row.pnlPct > 0);
  const negatives = rows.filter(row => row.pnlPct <= 0);
  const gain = positives.reduce((sum, row) => sum + row.pnlPct, 0);
  const loss = negatives.reduce((sum, row) => sum + row.pnlPct, 0);
  return {
    n: rows.length,
    winRate: round(positives.length / rows.length * 100, 1),
    avgPct: round(rows.reduce((sum, row) => sum + row.pnlPct, 0) / rows.length),
    profitFactor: loss < 0 ? round(gain / Math.abs(loss), 2) : null,
    tp: rows.filter(row => row.why === 'TP').length,
    sl: rows.filter(row => row.why === 'SL').length,
    time: rows.filter(row => row.why === 'TIME').length,
  };
}

function clusterMetrics(rows) {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const clusters = [];
  for (const row of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last || row.t - last[last.length - 1].t > 30 * 60) clusters.push([row]);
    else last.push(row);
  }
  const averages = clusters.map(cluster => cluster.reduce((sum, row) => sum + row.pnlPct, 0) / cluster.length);
  return {
    clusters: clusters.length,
    avgPct: averages.length ? round(averages.reduce((sum, value) => sum + value, 0) / averages.length) : null,
    positivePct: averages.length ? round(averages.filter(value => value > 0).length / averages.length * 100, 1) : null,
  };
}

function segments(rows) {
  if (!rows.length) return [];
  const times = rows.map(row => row.t);
  const start = Math.min(...times);
  const end = Math.max(...times) + 1;
  const width = (end - start) / 3;
  return [0, 1, 2].map(index => {
    const lo = start + width * index;
    const hi = index === 2 ? end : start + width * (index + 1);
    const part = rows.filter(row => row.t >= lo && row.t < hi);
    return { segment: index + 1, from: new Date(lo * 1000).toISOString(), to: new Date(hi * 1000).toISOString(), ...metrics(part) };
  });
}

function variant(name, rows, predicate) {
  const selected = rows.filter(predicate);
  const bySegment = segments(selected);
  return {
    name,
    ...metrics(selected),
    clusters: clusterMetrics(selected),
    segments: bySegment,
    positiveSegments: bySegment.filter(segment => segment.avgPct != null && segment.avgPct > 0).length,
  };
}

function printVariant(row) {
  const pct = value => value == null ? '-' : `${value >= 0 ? '+' : ''}${value}%`;
  const segmentsText = row.segments.map(segment => pct(segment.avgPct)).join(' | ') || '-';
  console.log(`${row.name}: n=${row.n}, avg=${pct(row.avgPct)}, win=${row.winRate ?? '-'}%, PF=${row.profitFactor ?? '-'}, segments=${segmentsText} (${row.positiveSegments}/3 positive)`);
}

async function scanCoin(item, sampleStartSec, endSec, btc, exitCfg) {
  const [candles, daily] = await Promise.all([
    fetch5m(item.coin, DAYS + 2, endSec * 1000),
    fetchDaily(item.coin),
  ]);
  if (candles.length < 288 + MAX_HOLD_BARS + 1 || daily.size < 14) return [];
  const closes = candles.map(candle => candle.close);
  const rsi = rsiSeries(closes, 14);
  const ema9 = emaSeries(closes, 9);
  const rows = [];
  let nextAllowed = -Infinity;
  let activeDay = null;
  let dayHigh = 0;
  for (let index = 0; index < candles.length - MAX_HOLD_BARS; index++) {
    const candle = candles[index];
    const day = Math.floor(candle.t / DAY) * DAY;
    if (day !== activeDay) {
      activeDay = day;
      dayHigh = candle.high;
    } else {
      dayHigh = Math.max(dayHigh, candle.high);
    }
    if (candle.t < sampleStartSec || candle.t >= endSec) continue;
    if (index < nextAllowed) continue;
    const ctx = contextAt(candles, index, closes, rsi, ema9, daily, dayHigh, btc, item.volume);
    if (!ctx || !ctx.pass) continue;
    const outcome = simulate(candles, index, exitCfg);
    rows.push({ coin: item.coin, t: candle.t, ...ctx, ...outcome });
    nextAllowed = index + outcome.bars + COOLDOWN_BARS;
  }
  return rows;
}

(async () => {
  const started = Date.now();
  const endMs = Math.floor((Date.now() - FIVE_MIN_MS) / FIVE_MIN_MS) * FIVE_MIN_MS;
  const endSec = Math.floor(endMs / 1000);
  const sampleStartSec = endSec - DAYS * DAY;
  const exitCfg = configuredExit();

  console.log(`Loading current liquid universe (min $${Math.round(MIN_VOL / 1000)}K, max ${MAX_COINS})...`);
  const universe = await loadUniverse();
  if (!universe.length) throw new Error('No liquid USD pairs were available from Coinbase.');
  console.log(`Universe: ${universe.length} coins. Loading BTC history...`);
  const btcCandles = await fetch5m('BTC', DAYS + 9, endMs);
  const btc = buildBtcFeatures(btcCandles);
  if (!btc.size) throw new Error('BTC history could not be loaded.');

  const rows = [];
  let usableCoins = 0;
  for (let index = 0; index < universe.length; index++) {
    const item = universe[index];
    const coinRows = await scanCoin(item, sampleStartSec, endSec, btc, exitCfg);
    if (coinRows.length) usableCoins++;
    rows.push(...coinRows);
    process.stdout.write(index % 10 === 0 ? `\n[${index + 1}/${universe.length}] ${item.coin} trades=${rows.length} ` : '.');
  }
  console.log('\n');

  const variants = [
    variant('Current structural gate', rows, () => true),
    variant('Hypothesis: RSI 40-50', rows, row => row.rsi >= 40 && row.rsi < 50),
    variant('Hypothesis: range4 <4%', rows, row => row.range4Pct < 4),
    variant('Hypothesis: exclude flat pre-range run-up', rows, row => row.runUp24 < -3 || row.runUp24 > 3),
    variant('Hypothesis: drop from 4h high >=4%', rows, row => row.dropFromHigh4Pct >= 4),
  ];
  const overall = variants[0];
  const result = {
    version: 1,
    fingerprint: gateFingerprint(),
    generatedAt: new Date().toISOString(),
    config: { days: DAYS, minVolume: MIN_VOL, maxCoins: MAX_COINS, targetPct: exitCfg.targetPct, slPct: exitCfg.slPct, feeSidePct: exitCfg.feeSidePct, maxHoldHours: 48, cooldownHours: 4 },
    scope: {
      universeAsOf: new Date().toISOString(),
      selectedCoins: universe.map(item => ({ coin: item.coin, volume: round(item.volume, 2) })),
      usableCoins,
      modeledChecks: [
        'Bottom of 4h range (<25%)', 'RSI 5m recovering off its low', 'Price above EMA9 (5m)',
        '4h range no wider than 8%', 'Not after a pump (24h run-up <=15%)',
        'Within 10% of its 14-day high', 'Liquidity >= current $500K proxy',
        'BTC above EMA20 (1h)', 'BTC 7-day return positive',
      ],
      caveats: [
        'Historical bid/ask snapshots are unavailable, so the mandatory live spread check is not replayed.',
        'Coin liquidity and universe membership use the current Coinbase snapshot; this is a survivorship proxy.',
        'OHLC cannot order a candle that touches both target and stop; the simulator counts it as a stop.',
      ],
    },
    overall,
    variants,
    elapsedSeconds: round((Date.now() - started) / 1000, 1),
  };
  fs.writeFileSync(path.join(ROOT, 'scalp-gate-validation.json'), JSON.stringify(result, null, 2));

  console.log('Structural scalp gate validation');
  console.log(`Fingerprint: ${result.fingerprint || 'unavailable'} | target +${exitCfg.targetPct}% | stop -${exitCfg.slPct}% | fee ${exitCfg.feeSidePct}% per side`);
  variants.forEach(printVariant);
  console.log('Saved: scalp-gate-validation.json');
  console.log('Do not promote a hypothesis unless it remains positive in all three segments and survives a fresh live cohort.');
})().catch(error => {
  console.error('FATAL', error && error.message ? error.message : error);
  process.exit(1);
});
