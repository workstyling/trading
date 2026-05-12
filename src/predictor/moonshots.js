// Combined "moonshot" scanner: finds coins ready to fly.
//
// Per-coin parallel data fetch:
//   - Daily candles (30d)  → recovery pattern + structural signals (higher lows, up/down vol, wicks)
//   - Hourly candles (200) → live technical state (RSI, MACD, EMA stack, Bollinger)
//
// Score components (sum capped at 100):
//   recovery (drop+bounce+fresh)    0..25
//   structure (HL + green + wicks)  0..20
//   technical (RSI/MACD/EMA/heur)   0..20
//   volume quality (up vs down)     0..15
//   BTC-relative outperformance     0..15
//   liquidity / trap penalty        -30..+5

const fetch = require('node-fetch');
const { computeAll, snapshotAt } = require('./indicators');
const { vectorAt } = require('./features');
const { heuristicScore } = require('./signal');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCoinbaseCandles(coin, granularity, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=${granularity}`);
      if (r.status === 429) { await sleep(800 * (attempt + 1)); continue; }
      if (!r.ok) return null;
      const data = await r.json();
      if (!Array.isArray(data) || data.length < 5) return null;
      return data;
    } catch { return null; }
  }
  return null;
}

// ── Recovery + structure analysis on daily candles (30d) ──
// Coinbase rows: [time, low, high, open, close, volume] — newest first.
function analyzeDaily(dailyRaw) {
  const sorted = dailyRaw.slice(0, 30).reverse();
  if (sorted.length < 10) return null;

  const opens   = sorted.map(c => parseFloat(c[3]));
  const closes  = sorted.map(c => parseFloat(c[4]));
  const lows    = sorted.map(c => parseFloat(c[1]));
  const highs   = sorted.map(c => parseFloat(c[2]));
  const volumes = sorted.map(c => parseFloat(c[5]));

  // Recovery pattern
  let maxPrice = 0, maxIdx = 0;
  closes.forEach((p, i) => { if (p > maxPrice) { maxPrice = p; maxIdx = i; } });
  let minPrice = Infinity, minIdx = 0;
  for (let j = maxIdx; j < closes.length; j++) {
    if (closes[j] < minPrice) { minPrice = closes[j]; minIdx = j; }
  }
  const currentPrice = closes[closes.length - 1];
  const dropPct = maxPrice > 0 ? ((minPrice - maxPrice) / maxPrice) * 100 : 0;
  const recoveryPct = minPrice > 0 ? ((currentPrice - minPrice) / minPrice) * 100 : 0;
  const fromPeakPct = maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;
  const daysFromBottom = closes.length - 1 - minIdx;

  // Last-3-day momentum
  const last3 = closes.slice(-3);
  const isRising = last3.length >= 3 && last3[2] > last3[0];

  // Volume surge (5d vs prior 10d)
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const prevVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
  const volIncrease = prevVol > 0 ? recentVol / prevVol : 1;

  // ── Structure signals ──

  // Higher-lows count over last 7 days (4+ HLs in 6 comparisons = strong uptrend structure)
  const last7Lows = lows.slice(-7);
  let higherLows = 0;
  for (let i = 1; i < last7Lows.length; i++) {
    if (last7Lows[i] >= last7Lows[i - 1]) higherLows++;
  }

  // Green candles in last 5 days
  const last5Closes = closes.slice(-5);
  const last5Opens = opens.slice(-5);
  let greenLast5 = 0;
  for (let i = 0; i < last5Closes.length; i++) {
    if (last5Closes[i] > last5Opens[i]) greenLast5++;
  }

  // Lower-wick % at recent bottoms — buyers stepping in produces long lower wicks
  // Average across the 3 lowest-priced candles in the dataset.
  const wickWindow = sorted.length;
  const indices = Array.from({ length: wickWindow }, (_, i) => i)
    .sort((a, b) => lows[a] - lows[b]).slice(0, 3);
  let lowerWickPct = 0;
  for (const i of indices) {
    const range = highs[i] - lows[i];
    if (range > 0) {
      const bodyLow = Math.min(opens[i], closes[i]);
      lowerWickPct += (bodyLow - lows[i]) / range;
    }
  }
  lowerWickPct = lowerWickPct / Math.max(1, indices.length);

  // ── Volume quality: ratio of volume on up days vs down days (last 10d) ──
  let upVol = 0, downVol = 0;
  const window10 = Math.min(10, sorted.length);
  for (let i = sorted.length - window10; i < sorted.length; i++) {
    if (closes[i] > opens[i]) upVol += volumes[i];
    else if (closes[i] < opens[i]) downVol += volumes[i];
  }
  const upDownVolRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 3 : 1);

  // ── Stronger trend & accumulation signals ──
  const slopeLast7 = linregSlopePct(closes, 7);
  const obvAccum = obvSlope(closes.slice(-Math.min(15, closes.length)), volumes.slice(-Math.min(15, volumes.length)));
  const vShape = vShapeQuality(lows, minIdx, 4);
  const maxSpike = maxSingleCandleMovePct(opens, closes, 5);

  return {
    currentPrice, peakPrice: maxPrice, bottomPrice: minPrice,
    dropPct, recoveryPct, fromPeakPct, daysFromBottom,
    isRising, volIncrease,
    higherLows, greenLast5, lowerWickPct, upDownVolRatio,
    slopeLast7, obvAccum, vShape, maxSpike,
    closes,
  };
}

// ── Technical analysis on hourly candles (~200) ──
function analyzeTechnical(hourlyRaw) {
  const sorted = hourlyRaw.slice().reverse();
  const candles = sorted.map(c => ({
    t: c[0] * 1000,
    low: parseFloat(c[1]),
    high: parseFloat(c[2]),
    open: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
  if (candles.length < 60) return null;

  const ind = computeAll(candles);
  let i = candles.length - 1;
  let v = null;
  while (i >= 0 && !(v = vectorAt(ind, i))) i--;
  if (!v) return null;

  const snap = snapshotAt(ind, i);
  const heur = heuristicScore(snap);
  const squeeze = detectSqueeze(ind.bbWidth, 20);
  return { snapshot: snap, heuristic: heur, squeeze };
}

// ── BTC reference: 30-day return for relative-strength comparison ──
function computeBtcReturn7d(btcDaily) {
  if (!btcDaily || btcDaily.length < 8) return 0;
  const sorted = btcDaily.slice(0, 8).reverse();
  const start = parseFloat(sorted[0][4]);
  const end = parseFloat(sorted[sorted.length - 1][4]);
  return start > 0 ? ((end - start) / start) * 100 : 0;
}

function compute7dReturn(closes) {
  if (closes.length < 8) return 0;
  const start = closes[closes.length - 8];
  const end = closes[closes.length - 1];
  return start > 0 ? ((end - start) / start) * 100 : 0;
}

// 24h return for Quick mode — uses last 24 hourly candles
function computeBtcReturn24h(btcHourly) {
  if (!btcHourly || btcHourly.length < 24) return 0;
  const sorted = btcHourly.slice(0, 24).reverse();
  const start = parseFloat(sorted[0][4]);
  const end = parseFloat(sorted[sorted.length - 1][4]);
  return start > 0 ? ((end - start) / start) * 100 : 0;
}
function compute24hReturn(closes) {
  if (closes.length < 24) return 0;
  const start = closes[closes.length - 24];
  const end = closes[closes.length - 1];
  return start > 0 ? ((end - start) / start) * 100 : 0;
}

// ── Scalp-mode analysis on 15-min candles (last 12h = 48 candles) ──
// For very short-term trades held 20-60 minutes — looking for a fresh local
// dip that has just turned. Tighter thresholds than Quick.
function analyzeScalp(min15Raw) {
  const sorted = min15Raw.slice(0, 48).reverse();
  if (sorted.length < 20) return null;

  const opens   = sorted.map(c => parseFloat(c[3]));
  const closes  = sorted.map(c => parseFloat(c[4]));
  const lows    = sorted.map(c => parseFloat(c[1]));
  const highs   = sorted.map(c => parseFloat(c[2]));
  const volumes = sorted.map(c => parseFloat(c[5]));

  let maxPrice = 0, maxIdx = 0;
  closes.forEach((p, i) => { if (p > maxPrice) { maxPrice = p; maxIdx = i; } });
  let minPrice = Infinity, minIdx = 0;
  for (let j = maxIdx; j < closes.length; j++) {
    if (closes[j] < minPrice) { minPrice = closes[j]; minIdx = j; }
  }
  const currentPrice = closes[closes.length - 1];
  const dropPct = maxPrice > 0 ? ((minPrice - maxPrice) / maxPrice) * 100 : 0;
  const recoveryPct = minPrice > 0 ? ((currentPrice - minPrice) / minPrice) * 100 : 0;
  const fromPeakPct = maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;
  // Each candle = 15 min. Convert to minutes for display.
  const candlesFromBottom = closes.length - 1 - minIdx;
  const minutesFromBottom = candlesFromBottom * 15;

  // Last 2 closes trend (30 min)
  const last2 = closes.slice(-2);
  const isRising = last2.length >= 2 && last2[1] > last2[0];

  // Volume surge: last 4 candles (1h) vs prior 8 (2h)
  const recentVol = volumes.slice(-4).reduce((a, b) => a + b, 0) / 4;
  const prevVol = volumes.slice(-12, -4).reduce((a, b) => a + b, 0) / 8;
  const volIncrease = prevVol > 0 ? recentVol / prevVol : 1;

  // Higher-lows count over last 8 candles (2h)
  const last8Lows = lows.slice(-8);
  let higherLows = 0;
  for (let i = 1; i < last8Lows.length; i++) {
    if (last8Lows[i] >= last8Lows[i - 1]) higherLows++;
  }

  // Green candles in last 4 candles (1h)
  const last4Closes = closes.slice(-4);
  const last4Opens = opens.slice(-4);
  let greenLast = 0;
  for (let i = 0; i < last4Closes.length; i++) {
    if (last4Closes[i] > last4Opens[i]) greenLast++;
  }

  // Lower-wick at bottom-cluster (3 lowest candles)
  const indices = Array.from({ length: sorted.length }, (_, i) => i)
    .sort((a, b) => lows[a] - lows[b]).slice(0, 3);
  let lowerWickPct = 0;
  for (const i of indices) {
    const range = highs[i] - lows[i];
    if (range > 0) {
      const bodyLow = Math.min(opens[i], closes[i]);
      lowerWickPct += (bodyLow - lows[i]) / range;
    }
  }
  lowerWickPct = lowerWickPct / Math.max(1, indices.length);

  // Up/down volume over last 12 candles (3h)
  let upVol = 0, downVol = 0;
  const window12 = Math.min(12, sorted.length);
  for (let i = sorted.length - window12; i < sorted.length; i++) {
    if (closes[i] > opens[i]) upVol += volumes[i];
    else if (closes[i] < opens[i]) downVol += volumes[i];
  }
  const upDownVolRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 3 : 1);

  const slopeLast4 = linregSlopePct(closes, 4);
  const obvAccum = obvSlope(closes.slice(-12), volumes.slice(-12));
  const vShape = vShapeQuality(lows, minIdx, 2);
  const maxSpike = maxSingleCandleMovePct(opens, closes, 4);

  return {
    currentPrice, peakPrice: maxPrice, bottomPrice: minPrice,
    dropPct, recoveryPct, fromPeakPct,
    minutesFromBottom, candlesFromBottom,
    isRising, volIncrease,
    higherLows, greenLast5: greenLast, lowerWickPct, upDownVolRatio,
    slopeLast4, obvAccum, vShape, maxSpike,
    closes,
  };
}

// 6h return for Scalp BTC-relative reference
function computeBtcReturn6h(btc15min) {
  if (!btc15min || btc15min.length < 24) return 0;
  const sorted = btc15min.slice(0, 24).reverse(); // 6 hours
  const start = parseFloat(sorted[0][4]);
  const end = parseFloat(sorted[sorted.length - 1][4]);
  return start > 0 ? ((end - start) / start) * 100 : 0;
}
function compute6hReturn(closes) {
  if (closes.length < 24) return 0;
  const start = closes[closes.length - 24];
  const end = closes[closes.length - 1];
  return start > 0 ? ((end - start) / start) * 100 : 0;
}

// ── Intra-mode analysis on hourly candles (last 24h = 1 day) ──
// Between Scalp and Quick — finds dips that happened within the last day and
// are turning, suitable for 1-3 hour holds.
function analyzeIntra(hourlyRaw) {
  const sorted = hourlyRaw.slice(0, 24).reverse();
  if (sorted.length < 12) return null;

  const opens   = sorted.map(c => parseFloat(c[3]));
  const closes  = sorted.map(c => parseFloat(c[4]));
  const lows    = sorted.map(c => parseFloat(c[1]));
  const highs   = sorted.map(c => parseFloat(c[2]));
  const volumes = sorted.map(c => parseFloat(c[5]));

  let maxPrice = 0, maxIdx = 0;
  closes.forEach((p, i) => { if (p > maxPrice) { maxPrice = p; maxIdx = i; } });
  let minPrice = Infinity, minIdx = 0;
  for (let j = maxIdx; j < closes.length; j++) {
    if (closes[j] < minPrice) { minPrice = closes[j]; minIdx = j; }
  }
  const currentPrice = closes[closes.length - 1];
  const dropPct = maxPrice > 0 ? ((minPrice - maxPrice) / maxPrice) * 100 : 0;
  const recoveryPct = minPrice > 0 ? ((currentPrice - minPrice) / minPrice) * 100 : 0;
  const fromPeakPct = maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;
  const hoursFromBottom = closes.length - 1 - minIdx;

  const last3 = closes.slice(-3);
  const isRising = last3.length >= 3 && last3[2] > last3[0];

  // Volume surge: last 3h vs prior 6h
  const recentVol = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prevVol = volumes.slice(-9, -3).reduce((a, b) => a + b, 0) / 6;
  const volIncrease = prevVol > 0 ? recentVol / prevVol : 1;

  // Higher-lows in last 6 hours
  const last6Lows = lows.slice(-6);
  let higherLows = 0;
  for (let i = 1; i < last6Lows.length; i++) {
    if (last6Lows[i] >= last6Lows[i - 1]) higherLows++;
  }
  // Green candles in last 4 hours
  const last4Closes = closes.slice(-4);
  const last4Opens = opens.slice(-4);
  let greenLast = 0;
  for (let i = 0; i < last4Closes.length; i++) {
    if (last4Closes[i] > last4Opens[i]) greenLast++;
  }

  const indices = Array.from({ length: sorted.length }, (_, i) => i)
    .sort((a, b) => lows[a] - lows[b]).slice(0, 4);
  let lowerWickPct = 0;
  for (const i of indices) {
    const range = highs[i] - lows[i];
    if (range > 0) {
      const bodyLow = Math.min(opens[i], closes[i]);
      lowerWickPct += (bodyLow - lows[i]) / range;
    }
  }
  lowerWickPct = lowerWickPct / Math.max(1, indices.length);

  // Up/down volume over last 12 hours
  let upVol = 0, downVol = 0;
  const window12 = Math.min(12, sorted.length);
  for (let i = sorted.length - window12; i < sorted.length; i++) {
    if (closes[i] > opens[i]) upVol += volumes[i];
    else if (closes[i] < opens[i]) downVol += volumes[i];
  }
  const upDownVolRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 3 : 1);

  const slopeLast6 = linregSlopePct(closes, 6);
  const obvAccum = obvSlope(closes.slice(-12), volumes.slice(-12));
  const vShape = vShapeQuality(lows, minIdx, 3);
  const maxSpike = maxSingleCandleMovePct(opens, closes, 4);

  return {
    currentPrice, peakPrice: maxPrice, bottomPrice: minPrice,
    dropPct, recoveryPct, fromPeakPct,
    hoursFromBottom,
    isRising, volIncrease,
    higherLows, greenLast5: greenLast, lowerWickPct, upDownVolRatio,
    slopeLast6, obvAccum, vShape, maxSpike,
    closes,
  };
}

// 12h return for Intra BTC-relative reference
function computeBtcReturn12h(btcHourly) {
  if (!btcHourly || btcHourly.length < 12) return 0;
  const sorted = btcHourly.slice(0, 12).reverse();
  const start = parseFloat(sorted[0][4]);
  const end = parseFloat(sorted[sorted.length - 1][4]);
  return start > 0 ? ((end - start) / start) * 100 : 0;
}
function compute12hReturn(closes) {
  if (closes.length < 12) return 0;
  const start = closes[closes.length - 12];
  const end = closes[closes.length - 1];
  return start > 0 ? ((end - start) / start) * 100 : 0;
}

// ── Quick-mode analysis on hourly candles (last 72h = 3 days) ──
// Same shape as analyzeDaily but counts in hours, with tighter filters.
function analyzeQuick(hourlyRaw) {
  const sorted = hourlyRaw.slice(0, 72).reverse();
  if (sorted.length < 24) return null;

  const opens   = sorted.map(c => parseFloat(c[3]));
  const closes  = sorted.map(c => parseFloat(c[4]));
  const lows    = sorted.map(c => parseFloat(c[1]));
  const highs   = sorted.map(c => parseFloat(c[2]));
  const volumes = sorted.map(c => parseFloat(c[5]));

  // Peak in window, then deepest bottom after the peak
  let maxPrice = 0, maxIdx = 0;
  closes.forEach((p, i) => { if (p > maxPrice) { maxPrice = p; maxIdx = i; } });
  let minPrice = Infinity, minIdx = 0;
  for (let j = maxIdx; j < closes.length; j++) {
    if (closes[j] < minPrice) { minPrice = closes[j]; minIdx = j; }
  }
  const currentPrice = closes[closes.length - 1];
  const dropPct = maxPrice > 0 ? ((minPrice - maxPrice) / maxPrice) * 100 : 0;
  const recoveryPct = minPrice > 0 ? ((currentPrice - minPrice) / minPrice) * 100 : 0;
  const fromPeakPct = maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;
  const hoursFromBottom = closes.length - 1 - minIdx;

  // Last 3 hourly closes trend
  const last3 = closes.slice(-3);
  const isRising = last3.length >= 3 && last3[2] > last3[0];

  // Volume surge: last 6h vs prior 12h
  const recentVol = volumes.slice(-6).reduce((a, b) => a + b, 0) / 6;
  const prevVol = volumes.slice(-18, -6).reduce((a, b) => a + b, 0) / 12;
  const volIncrease = prevVol > 0 ? recentVol / prevVol : 1;

  // Higher-lows count over last 12 hours
  const last12Lows = lows.slice(-12);
  let higherLows = 0;
  for (let i = 1; i < last12Lows.length; i++) {
    if (last12Lows[i] >= last12Lows[i - 1]) higherLows++;
  }

  // Green candles in last 6 hours
  const last6Closes = closes.slice(-6);
  const last6Opens = opens.slice(-6);
  let greenLast = 0;
  for (let i = 0; i < last6Closes.length; i++) {
    if (last6Closes[i] > last6Opens[i]) greenLast++;
  }

  // Lower-wick % at bottom-cluster candles
  const indices = Array.from({ length: sorted.length }, (_, i) => i)
    .sort((a, b) => lows[a] - lows[b]).slice(0, 5);
  let lowerWickPct = 0;
  for (const i of indices) {
    const range = highs[i] - lows[i];
    if (range > 0) {
      const bodyLow = Math.min(opens[i], closes[i]);
      lowerWickPct += (bodyLow - lows[i]) / range;
    }
  }
  lowerWickPct = lowerWickPct / Math.max(1, indices.length);

  // Up vs down hourly volume over last 24h
  let upVol = 0, downVol = 0;
  const window24 = Math.min(24, sorted.length);
  for (let i = sorted.length - window24; i < sorted.length; i++) {
    if (closes[i] > opens[i]) upVol += volumes[i];
    else if (closes[i] < opens[i]) downVol += volumes[i];
  }
  const upDownVolRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 3 : 1);

  const slopeLast12 = linregSlopePct(closes, 12);
  const obvAccum = obvSlope(closes.slice(-24), volumes.slice(-24));
  const vShape = vShapeQuality(lows, minIdx, 4);
  const maxSpike = maxSingleCandleMovePct(opens, closes, 6);

  return {
    currentPrice, peakPrice: maxPrice, bottomPrice: minPrice,
    dropPct, recoveryPct, fromPeakPct,
    hoursFromBottom,
    isRising, volIncrease,
    higherLows, greenLast5: greenLast, lowerWickPct, upDownVolRatio,
    slopeLast12, obvAccum, vShape, maxSpike,
    closes,
  };
}

// How many ATR-units away from the bottom the current price sits.
// <1 = entry still right at base · 2-3 = mid-recovery · >4 = chased.
function chaseAtrUnits(currentPrice, bottomPrice, atr) {
  if (!atr || atr <= 0) return null;
  return (currentPrice - bottomPrice) / atr;
}

// Linear regression slope on the last N closes, expressed as % of mean price per candle.
// Positive slope = uptrend, magnitude tells you how steep. More robust than "last close > prior".
function linregSlopePct(closes, n) {
  const len = Math.min(n, closes.length);
  if (len < 4) return 0;
  const tail = closes.slice(-len);
  const mean = tail.reduce((a, b) => a + b, 0) / len;
  if (mean === 0) return 0;
  const xMean = (len - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < len; i++) {
    num += (i - xMean) * (tail[i] - mean);
    den += (i - xMean) ** 2;
  }
  if (den === 0) return 0;
  return (num / den) / mean * 100;
}

// On-Balance Volume — running sum of volumes signed by close-vs-prev-close direction.
// Returns OBV slope (% change between halves of the series) — positive = accumulation,
// negative = distribution. Useful when price is flat but volume tells you smart money is buying.
function obvSlope(closes, volumes) {
  if (closes.length < 6 || volumes.length < 6) return 0;
  const obv = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - volumes[i];
    else obv[i] = obv[i - 1];
  }
  // Compare last third average to first third average
  const third = Math.floor(closes.length / 3);
  const firstAvg = obv.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const lastAvg = obv.slice(-third).reduce((a, b) => a + b, 0) / third;
  const range = Math.max(1, Math.abs(firstAvg) + Math.abs(lastAvg));
  return ((lastAvg - firstAvg) / range) * 100;
}

// Bollinger Squeeze detector: returns true if current BB width is in the bottom 25%
// of width values across the lookback and is now expanding (most recent > prior).
// Coiled-spring setup that often precedes explosive moves.
function detectSqueeze(bbWidths, lookback = 20) {
  const tail = bbWidths.slice(-lookback).filter(v => !isNaN(v) && v != null);
  if (tail.length < 5) return false;
  const current = tail[tail.length - 1];
  const prev = tail[tail.length - 2];
  // Rank current vs the recent distribution
  const sorted = tail.slice().sort((a, b) => a - b);
  const percentile = sorted.indexOf(current) / sorted.length;
  return percentile < 0.25 && current > prev * 0.95; // tight + starting to widen
}

// Largest single-candle move (%) in the last N candles. Big single-bar pumps tend to
// mean-revert — exit pressure on the next candle is high, so a high-quality "moonshot"
// shouldn't have one of these in its recent history.
function maxSingleCandleMovePct(opens, closes, n) {
  const len = Math.min(n, closes.length);
  let max = 0;
  for (let i = closes.length - len; i < closes.length; i++) {
    if (opens[i] > 0) {
      const move = Math.abs((closes[i] - opens[i]) / opens[i]) * 100;
      if (move > max) max = move;
    }
  }
  return max;
}

// V-shape quality: is the bottom a clear local low, or just noise?
// Returns 0..1 — fraction of surrounding candles whose low is above the bottom.
// 1.0 = perfect V, 0.5 = noisy/sideways, 0 = bottom isn't really a low.
function vShapeQuality(lows, bottomIdx, windowEachSide = 5) {
  const n = lows.length;
  const bottomLow = lows[bottomIdx];
  let above = 0, total = 0;
  const start = Math.max(0, bottomIdx - windowEachSide);
  const end = Math.min(n - 1, bottomIdx + windowEachSide);
  for (let i = start; i <= end; i++) {
    if (i === bottomIdx) continue;
    total++;
    if (lows[i] > bottomLow) above++;
  }
  return total > 0 ? above / total : 0;
}

// ── Composite scoring ──
function compositeScore(d, tech, volUsd, btcReturn7d) {
  // Recovery component (0..25)
  let recComp = 0;
  if (d) {
    const dropScore = Math.min(Math.abs(d.dropPct) * 0.18, 10);    // bigger drop = more upside
    const bounceScore = Math.min(d.recoveryPct * 0.25, 10);         // bouncing = momentum
    const freshScore = d.daysFromBottom <= 5 ? 5 : d.daysFromBottom <= 9 ? 3 : 0;
    recComp = dropScore + bounceScore + freshScore;
  }

  // Structure component (0..20)
  let structComp = 0;
  if (d) {
    structComp += Math.min(d.higherLows * 2.5, 10);
    structComp += d.greenLast5 * 1.5;
    structComp += Math.min(d.lowerWickPct * 30, 5);
  }

  // Technical component (0..20)
  let techComp = 0;
  if (tech) {
    techComp += Math.max(0, tech.heuristic) * 0.25;
    const r = tech.snapshot.rsi14;
    if (r >= 35 && r <= 60) techComp += 5;
    else if (r > 75) techComp -= 5;
    if (tech.snapshot.macd > tech.snapshot.macdSignal) techComp += 3;
    if (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) techComp += 3;
  }

  // Volume quality (0..15)
  let volQualComp = 0;
  if (d) {
    volQualComp = Math.min(Math.max(0, (d.upDownVolRatio - 1) * 7), 12);
    if (d.volIncrease > 1.5) volQualComp += 3;
  }

  // BTC-relative outperformance (0..15)
  let btcRelComp = 0;
  if (d && btcReturn7d != null) {
    const coin7d = compute7dReturn(d.closes);
    const outperf = coin7d - btcReturn7d;
    if (outperf > 0) btcRelComp = Math.min(outperf * 0.5, 15);
  }

  // Bonus / penalty pile
  let bonus = 0;
  if (volUsd < 50000) bonus -= 25;
  else if (volUsd < 200000) bonus -= 10;
  else if (volUsd > 5000000) bonus += 5;
  if (tech && tech.snapshot.rsi14 > 75 && d && d.recoveryPct > 50) bonus -= 8;
  if (!tech) bonus -= 5;

  // Late-entry penalty
  if (d && d.recoveryPct > 30) {
    bonus -= Math.min((d.recoveryPct - 30) * 0.3, 25);
  }
  // Chase penalty
  if (tech && d) {
    const ch = chaseAtrUnits(d.currentPrice, d.bottomPrice, tech.snapshot.atr14);
    if (ch != null) {
      if (ch < 1.5) bonus += 3;
      else if (ch > 4) bonus -= 6;
      else if (ch > 3) bonus -= 3;
    }
  }
  if (d && d.recoveryPct < 3 && !d.isRising) bonus -= 6;

  // ── New confluence signals ──
  // Linear-regression slope confirms trend strength (more reliable than last3 check)
  if (d && d.slopeLast7 != null) {
    if (d.slopeLast7 > 1.5) bonus += 5;        // strong uptrend in last week
    else if (d.slopeLast7 > 0.5) bonus += 2;
    else if (d.slopeLast7 < -1) bonus -= 4;    // still trending down
  }
  // OBV accumulation: volume confirms direction. Positive while price flat = smart money buying.
  if (d && d.obvAccum != null) {
    if (d.obvAccum > 25) bonus += 4;          // strong accumulation
    else if (d.obvAccum > 10) bonus += 2;
    else if (d.obvAccum < -15) bonus -= 4;    // distribution — exit pressure
  }
  // V-shape quality: clear local low = real reversal, noisy = false signal
  if (d && d.vShape != null) {
    if (d.vShape >= 0.85) bonus += 3;         // very clean V
    else if (d.vShape < 0.4) bonus -= 4;      // bottom isn't actually a low
  }
  // Hard RSI cap — overbought entries fail too often
  if (tech && tech.snapshot.rsi14 > 80) bonus -= 12;
  // Bollinger Squeeze: tight bands now expanding = coiled spring setup
  if (tech && tech.squeeze) bonus += 4;
  // Single-candle pump guard: a >12% one-bar move usually mean-reverts
  if (d && d.maxSpike != null) {
    if (d.maxSpike > 25) bonus -= 6;
    else if (d.maxSpike > 12) bonus -= 3;
  }

  const total = recComp + structComp + techComp + volQualComp + btcRelComp + bonus;
  return {
    score: Math.max(0, Math.min(100, total)),
    breakdown: {
      recovery: Math.round(recComp * 10) / 10,
      structure: Math.round(structComp * 10) / 10,
      technical: Math.round(techComp * 10) / 10,
      volQuality: Math.round(volQualComp * 10) / 10,
      btcRel: Math.round(btcRelComp * 10) / 10,
      bonus: Math.round(bonus * 10) / 10,
    },
  };
}

async function scanOneSwing(coin, volumeCache, btcContext) {
  const [daily, hourly] = await Promise.all([
    fetchCoinbaseCandles(coin, 86400),
    fetchCoinbaseCandles(coin, 3600),
  ]);
  if (!daily) return null;

  const d = analyzeDaily(daily);
  if (!d) return null;

  // Filter: meaningful drop AND some recovery AND fresh bottom AND not already extended
  if (!(d.dropPct < -10 && d.recoveryPct > 1 && d.daysFromBottom > 0 && d.daysFromBottom <= 25)) {
    return null;
  }
  // Hard skip: monsters that already 10x'd from bottom — already done running
  if (d.recoveryPct > 200) return null;

  const tech = hourly ? analyzeTechnical(hourly) : null;
  const volUsd = volumeCache?.get(coin) || 0;
  const btc7d = btcContext?.btcReturn7d ?? 0;
  const coin7d = compute7dReturn(d.closes);
  const { score, breakdown } = compositeScore(d, tech, volUsd, btc7d);

  // Actionable trade levels: stop just below the recent bottom (give it a 1.5% buffer
  // to avoid wick-out), take-profit at 2:1 vs the stop using the entry price.
  const atrVal = tech ? tech.snapshot.atr14 : null;
  const chaseAtr = atrVal ? chaseAtrUnits(d.currentPrice, d.bottomPrice, atrVal) : null;
  const slPrice = d.bottomPrice * 0.985;
  const risk = d.currentPrice - slPrice;
  const tpPrice = risk > 0 ? d.currentPrice + risk * 2 : null;

  return {
    coin,
    mode: 'swing',
    score: Math.round(score * 10) / 10,
    breakdown,
    currentPrice: d.currentPrice,
    peakPrice: d.peakPrice,
    bottomPrice: d.bottomPrice,
    dropPct: Math.round(d.dropPct * 100) / 100,
    recoveryPct: Math.round(d.recoveryPct * 100) / 100,
    fromPeakPct: Math.round(d.fromPeakPct * 100) / 100,
    daysFromBottom: d.daysFromBottom,
    isRising: d.isRising,
    volIncrease: Math.round(d.volIncrease * 100) / 100,
    volume24h: Math.round(volUsd),
    higherLows: d.higherLows,
    greenLast5: d.greenLast5,
    lowerWickPct: Math.round(d.lowerWickPct * 1000) / 10,
    upDownVolRatio: Math.round(d.upDownVolRatio * 100) / 100,
    slope: d.slopeLast7 != null ? Math.round(d.slopeLast7 * 100) / 100 : null,
    obvAccum: d.obvAccum != null ? Math.round(d.obvAccum * 10) / 10 : null,
    vShape: d.vShape != null ? Math.round(d.vShape * 100) / 100 : null,
    maxSpike: d.maxSpike != null ? Math.round(d.maxSpike * 10) / 10 : null,
    squeeze: tech ? !!tech.squeeze : null,
    coin7dReturn: Math.round(coin7d * 100) / 100,
    btc7dReturn: Math.round(btc7d * 100) / 100,
    relativeStrength: Math.round((coin7d - btc7d) * 100) / 100,
    rsi: tech ? Math.round(tech.snapshot.rsi14 * 10) / 10 : null,
    macdHist: tech ? tech.snapshot.macdHist : null,
    macdBullish: tech ? (tech.snapshot.macd > tech.snapshot.macdSignal) : null,
    emaStackBullish: tech ? (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) : null,
    bbPos: tech && (tech.snapshot.bbUpper - tech.snapshot.bbLower) > 0
      ? Math.round((tech.snapshot.close - tech.snapshot.bbLower) / (tech.snapshot.bbUpper - tech.snapshot.bbLower) * 100) / 100
      : null,
    atr: atrVal,
    heuristic: tech ? tech.heuristic : null,
    chaseAtr: chaseAtr != null ? Math.round(chaseAtr * 100) / 100 : null,
    slPrice: Math.round(slPrice * 1e8) / 1e8,
    tpPrice: tpPrice != null ? Math.round(tpPrice * 1e8) / 1e8 : null,
  };
}

async function scanOneQuick(coin, volumeCache, btcContext) {
  const hourly = await fetchCoinbaseCandles(coin, 3600);
  if (!hourly) return null;
  const q = analyzeQuick(hourly);
  if (!q) return null;

  // Quick-mode filters: stronger drop in short window, fresh bottom in last 18h,
  // some recovery underway. Tighter than swing mode because we want only setups
  // that are still close to ignition.
  if (!(q.dropPct < -6 && q.recoveryPct > 0.5 && q.hoursFromBottom > 0 && q.hoursFromBottom <= 18)) {
    return null;
  }
  if (q.recoveryPct > 50) return null; // already ran

  // Technical state from the same hourly data
  const tech = analyzeTechnical(hourly);
  const volUsd = volumeCache?.get(coin) || 0;
  const btc24h = btcContext?.btcReturn24h ?? 0;
  const coin24h = compute24hReturn(q.closes);

  // Quick-mode scoring — boosts freshness and live momentum, less weight on structure
  let recComp = 0;
  recComp += Math.min(Math.abs(q.dropPct) * 0.5, 12);
  recComp += Math.min(q.recoveryPct * 0.7, 8);
  recComp += q.hoursFromBottom <= 3 ? 8 : q.hoursFromBottom <= 6 ? 5 : q.hoursFromBottom <= 12 ? 2 : 0;

  let structComp = 0;
  structComp += Math.min(q.higherLows * 1.3, 8);
  structComp += q.greenLast5 * 1.2;
  structComp += Math.min(q.lowerWickPct * 25, 4);

  let techComp = 0;
  if (tech) {
    techComp += Math.max(0, tech.heuristic) * 0.25;
    const r = tech.snapshot.rsi14;
    if (r >= 30 && r <= 55) techComp += 6;
    else if (r > 75) techComp -= 6;
    if (tech.snapshot.macd > tech.snapshot.macdSignal) techComp += 3;
    if (tech.snapshot.ema9 > tech.snapshot.ema21) techComp += 2;
  }

  let volQualComp = Math.min(Math.max(0, (q.upDownVolRatio - 1) * 6), 12);
  if (q.volIncrease > 1.5) volQualComp += 3;

  let btcRelComp = 0;
  const outperf = coin24h - btc24h;
  if (outperf > 0) btcRelComp = Math.min(outperf * 0.7, 15);

  let bonus = 0;
  if (volUsd < 50000) bonus -= 25;
  else if (volUsd < 200000) bonus -= 10;
  else if (volUsd > 5000000) bonus += 5;
  if (tech && tech.snapshot.rsi14 > 78) bonus -= 8;
  if (!tech) bonus -= 5;
  if (q.recoveryPct > 15) bonus -= Math.min((q.recoveryPct - 15) * 0.5, 20);
  if (tech) {
    const ch = chaseAtrUnits(q.currentPrice, q.bottomPrice, tech.snapshot.atr14);
    if (ch != null) {
      if (ch < 1.2) bonus += 3;
      else if (ch > 3.5) bonus -= 6;
      else if (ch > 2.5) bonus -= 3;
    }
  }
  if (q.recoveryPct < 1.5 && !q.isRising) bonus -= 6;
  // New confluence signals
  if (q.slopeLast12 != null) {
    if (q.slopeLast12 > 0.5) bonus += 4;
    else if (q.slopeLast12 < -0.5) bonus -= 4;
  }
  if (q.obvAccum != null) {
    if (q.obvAccum > 20) bonus += 3;
    else if (q.obvAccum < -15) bonus -= 4;
  }
  if (q.vShape != null) {
    if (q.vShape >= 0.85) bonus += 3;
    else if (q.vShape < 0.4) bonus -= 3;
  }
  if (tech && tech.snapshot.rsi14 > 82) bonus -= 10;
  if (tech && tech.squeeze) bonus += 4;
  if (q.maxSpike != null) {
    if (q.maxSpike > 15) bonus -= 5;
    else if (q.maxSpike > 8) bonus -= 2;
  }

  const total = recComp + structComp + techComp + volQualComp + btcRelComp + bonus;
  const score = Math.max(0, Math.min(100, total));
  const breakdown = {
    recovery: Math.round(recComp * 10) / 10,
    structure: Math.round(structComp * 10) / 10,
    technical: Math.round(techComp * 10) / 10,
    volQuality: Math.round(volQualComp * 10) / 10,
    btcRel: Math.round(btcRelComp * 10) / 10,
    bonus: Math.round(bonus * 10) / 10,
  };

  const atrVal = tech ? tech.snapshot.atr14 : null;
  const chaseAtr = atrVal ? chaseAtrUnits(q.currentPrice, q.bottomPrice, atrVal) : null;
  const slPrice = q.bottomPrice * 0.99; // tighter buffer in quick mode
  const risk = q.currentPrice - slPrice;
  const tpPrice = risk > 0 ? q.currentPrice + risk * 2 : null;

  return {
    coin,
    mode: 'quick',
    score: Math.round(score * 10) / 10,
    breakdown,
    currentPrice: q.currentPrice,
    peakPrice: q.peakPrice,
    bottomPrice: q.bottomPrice,
    dropPct: Math.round(q.dropPct * 100) / 100,
    recoveryPct: Math.round(q.recoveryPct * 100) / 100,
    fromPeakPct: Math.round(q.fromPeakPct * 100) / 100,
    hoursFromBottom: q.hoursFromBottom,
    daysFromBottom: null,
    isRising: q.isRising,
    volIncrease: Math.round(q.volIncrease * 100) / 100,
    volume24h: Math.round(volUsd),
    higherLows: q.higherLows,
    greenLast5: q.greenLast5,
    lowerWickPct: Math.round(q.lowerWickPct * 1000) / 10,
    upDownVolRatio: Math.round(q.upDownVolRatio * 100) / 100,
    slope: q.slopeLast12 != null ? Math.round(q.slopeLast12 * 100) / 100 : null,
    obvAccum: q.obvAccum != null ? Math.round(q.obvAccum * 10) / 10 : null,
    vShape: q.vShape != null ? Math.round(q.vShape * 100) / 100 : null,
    maxSpike: q.maxSpike != null ? Math.round(q.maxSpike * 10) / 10 : null,
    squeeze: tech ? !!tech.squeeze : null,
    coin24hReturn: Math.round(coin24h * 100) / 100,
    btc24hReturn: Math.round(btc24h * 100) / 100,
    relativeStrength: Math.round((coin24h - btc24h) * 100) / 100,
    rsi: tech ? Math.round(tech.snapshot.rsi14 * 10) / 10 : null,
    macdHist: tech ? tech.snapshot.macdHist : null,
    macdBullish: tech ? (tech.snapshot.macd > tech.snapshot.macdSignal) : null,
    emaStackBullish: tech ? (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) : null,
    bbPos: tech && (tech.snapshot.bbUpper - tech.snapshot.bbLower) > 0
      ? Math.round((tech.snapshot.close - tech.snapshot.bbLower) / (tech.snapshot.bbUpper - tech.snapshot.bbLower) * 100) / 100
      : null,
    atr: atrVal,
    heuristic: tech ? tech.heuristic : null,
    chaseAtr: chaseAtr != null ? Math.round(chaseAtr * 100) / 100 : null,
    slPrice: Math.round(slPrice * 1e8) / 1e8,
    tpPrice: tpPrice != null ? Math.round(tpPrice * 1e8) / 1e8 : null,
  };
}

async function scanOneScalp(coin, volumeCache, btcContext) {
  // 15-min candles only — also use them to derive a current technical snapshot.
  const min15 = await fetchCoinbaseCandles(coin, 900);
  if (!min15) return null;
  const s = analyzeScalp(min15);
  if (!s) return null;

  // Filters tuned for very-short-term entries: small but real drop, fresh bottom (≤ 2h),
  // and signs of life (recovery, not still bleeding).
  if (!(s.dropPct < -3 && s.recoveryPct > 0.3 && s.candlesFromBottom > 0 && s.candlesFromBottom <= 8)) {
    return null;
  }
  if (s.recoveryPct > 12) return null; // already mostly recovered

  // Reuse the 15-min series for a technical snapshot — analyzeTechnical needs
  // hourly-style bars but works on any timeframe where indicators have enough warmup.
  const tech = analyzeTechnical(min15);
  const volUsd = volumeCache?.get(coin) || 0;
  const btc6h = btcContext?.btcReturn6h ?? 0;
  const coin6h = compute6hReturn(s.closes);

  // Scoring: freshness is everything in scalp mode
  let recComp = 0;
  recComp += Math.min(Math.abs(s.dropPct) * 0.8, 10);
  recComp += Math.min(s.recoveryPct * 1.2, 6);
  recComp += s.candlesFromBottom <= 2 ? 8 : s.candlesFromBottom <= 4 ? 5 : 2;

  let structComp = 0;
  structComp += Math.min(s.higherLows * 1.2, 6);
  structComp += s.greenLast5 * 1.5; // up to 6
  structComp += Math.min(s.lowerWickPct * 25, 4);

  let techComp = 0;
  if (tech) {
    techComp += Math.max(0, tech.heuristic) * 0.2;
    const r = tech.snapshot.rsi14;
    if (r >= 30 && r <= 50) techComp += 6;
    else if (r > 75) techComp -= 6;
    if (tech.snapshot.macd > tech.snapshot.macdSignal) techComp += 3;
    if (tech.snapshot.ema9 > tech.snapshot.ema21) techComp += 2;
  }

  let volQualComp = Math.min(Math.max(0, (s.upDownVolRatio - 1) * 6), 12);
  if (s.volIncrease > 1.8) volQualComp += 3;

  let btcRelComp = 0;
  const outperf = coin6h - btc6h;
  if (outperf > 0) btcRelComp = Math.min(outperf * 1.2, 15);

  let bonus = 0;
  if (volUsd < 50000) bonus -= 25;
  else if (volUsd < 200000) bonus -= 10;
  else if (volUsd > 5000000) bonus += 5;
  if (tech && tech.snapshot.rsi14 > 78) bonus -= 8;
  if (!tech) bonus -= 5;
  if (s.recoveryPct > 5) bonus -= Math.min((s.recoveryPct - 5) * 1.2, 15);
  if (tech) {
    const ch = chaseAtrUnits(s.currentPrice, s.bottomPrice, tech.snapshot.atr14);
    if (ch != null) {
      if (ch < 1) bonus += 3;
      else if (ch > 2.5) bonus -= 5;
      else if (ch > 1.8) bonus -= 2;
    }
  }
  if (s.recoveryPct < 0.8 && !s.isRising) bonus -= 6;
  // New confluence signals
  if (s.slopeLast4 != null) {
    if (s.slopeLast4 > 0.4) bonus += 4;
    else if (s.slopeLast4 < -0.4) bonus -= 4;
  }
  if (s.obvAccum != null) {
    if (s.obvAccum > 20) bonus += 3;
    else if (s.obvAccum < -15) bonus -= 4;
  }
  if (s.vShape != null) {
    if (s.vShape >= 0.85) bonus += 3;
    else if (s.vShape < 0.4) bonus -= 3;
  }
  if (tech && tech.snapshot.rsi14 > 83) bonus -= 10;
  if (tech && tech.squeeze) bonus += 4;
  if (s.maxSpike != null) {
    if (s.maxSpike > 8) bonus -= 4;
    else if (s.maxSpike > 4) bonus -= 2;
  }

  const total = recComp + structComp + techComp + volQualComp + btcRelComp + bonus;
  const score = Math.max(0, Math.min(100, total));
  const breakdown = {
    recovery: Math.round(recComp * 10) / 10,
    structure: Math.round(structComp * 10) / 10,
    technical: Math.round(techComp * 10) / 10,
    volQuality: Math.round(volQualComp * 10) / 10,
    btcRel: Math.round(btcRelComp * 10) / 10,
    bonus: Math.round(bonus * 10) / 10,
  };

  const atrVal = tech ? tech.snapshot.atr14 : null;
  const chaseAtr = atrVal ? chaseAtrUnits(s.currentPrice, s.bottomPrice, atrVal) : null;
  const slPrice = s.bottomPrice * 0.995; // very tight buffer for scalp
  const risk = s.currentPrice - slPrice;
  const tpPrice = risk > 0 ? s.currentPrice + risk * 2 : null;

  return {
    coin,
    mode: 'scalp',
    score: Math.round(score * 10) / 10,
    breakdown,
    currentPrice: s.currentPrice,
    peakPrice: s.peakPrice,
    bottomPrice: s.bottomPrice,
    dropPct: Math.round(s.dropPct * 100) / 100,
    recoveryPct: Math.round(s.recoveryPct * 100) / 100,
    fromPeakPct: Math.round(s.fromPeakPct * 100) / 100,
    minutesFromBottom: s.minutesFromBottom,
    hoursFromBottom: null,
    daysFromBottom: null,
    isRising: s.isRising,
    volIncrease: Math.round(s.volIncrease * 100) / 100,
    volume24h: Math.round(volUsd),
    higherLows: s.higherLows,
    greenLast5: s.greenLast5,
    lowerWickPct: Math.round(s.lowerWickPct * 1000) / 10,
    upDownVolRatio: Math.round(s.upDownVolRatio * 100) / 100,
    slope: s.slopeLast4 != null ? Math.round(s.slopeLast4 * 100) / 100 : null,
    obvAccum: s.obvAccum != null ? Math.round(s.obvAccum * 10) / 10 : null,
    vShape: s.vShape != null ? Math.round(s.vShape * 100) / 100 : null,
    maxSpike: s.maxSpike != null ? Math.round(s.maxSpike * 10) / 10 : null,
    squeeze: tech ? !!tech.squeeze : null,
    coin6hReturn: Math.round(coin6h * 100) / 100,
    btc6hReturn: Math.round(btc6h * 100) / 100,
    relativeStrength: Math.round((coin6h - btc6h) * 100) / 100,
    rsi: tech ? Math.round(tech.snapshot.rsi14 * 10) / 10 : null,
    macdHist: tech ? tech.snapshot.macdHist : null,
    macdBullish: tech ? (tech.snapshot.macd > tech.snapshot.macdSignal) : null,
    emaStackBullish: tech ? (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) : null,
    bbPos: tech && (tech.snapshot.bbUpper - tech.snapshot.bbLower) > 0
      ? Math.round((tech.snapshot.close - tech.snapshot.bbLower) / (tech.snapshot.bbUpper - tech.snapshot.bbLower) * 100) / 100
      : null,
    atr: atrVal,
    heuristic: tech ? tech.heuristic : null,
    chaseAtr: chaseAtr != null ? Math.round(chaseAtr * 100) / 100 : null,
    slPrice: Math.round(slPrice * 1e8) / 1e8,
    tpPrice: tpPrice != null ? Math.round(tpPrice * 1e8) / 1e8 : null,
  };
}

async function scanOneIntra(coin, volumeCache, btcContext) {
  const hourly = await fetchCoinbaseCandles(coin, 3600);
  if (!hourly) return null;
  const ix = analyzeIntra(hourly);
  if (!ix) return null;

  // Intra filters: meaningful drop in last day, bottom within 6h, some recovery
  if (!(ix.dropPct < -4 && ix.recoveryPct > 0.8 && ix.hoursFromBottom > 0 && ix.hoursFromBottom <= 6)) {
    return null;
  }
  if (ix.recoveryPct > 25) return null;

  const tech = analyzeTechnical(hourly);
  const volUsd = volumeCache?.get(coin) || 0;
  const btc12h = btcContext?.btcReturn12h ?? 0;
  const coin12h = compute12hReturn(ix.closes);

  // Scoring tuned between Scalp and Quick
  let recComp = 0;
  recComp += Math.min(Math.abs(ix.dropPct) * 0.6, 12);
  recComp += Math.min(ix.recoveryPct * 0.9, 8);
  recComp += ix.hoursFromBottom <= 1 ? 8 : ix.hoursFromBottom <= 3 ? 5 : 2;

  let structComp = 0;
  structComp += Math.min(ix.higherLows * 1.5, 8);
  structComp += ix.greenLast5 * 1.4;
  structComp += Math.min(ix.lowerWickPct * 25, 4);

  let techComp = 0;
  if (tech) {
    techComp += Math.max(0, tech.heuristic) * 0.22;
    const r = tech.snapshot.rsi14;
    if (r >= 30 && r <= 55) techComp += 6;
    else if (r > 75) techComp -= 6;
    if (tech.snapshot.macd > tech.snapshot.macdSignal) techComp += 3;
    if (tech.snapshot.ema9 > tech.snapshot.ema21) techComp += 2;
  }

  let volQualComp = Math.min(Math.max(0, (ix.upDownVolRatio - 1) * 6.5), 12);
  if (ix.volIncrease > 1.6) volQualComp += 3;

  let btcRelComp = 0;
  const outperf = coin12h - btc12h;
  if (outperf > 0) btcRelComp = Math.min(outperf * 0.9, 15);

  let bonus = 0;
  if (volUsd < 50000) bonus -= 25;
  else if (volUsd < 200000) bonus -= 10;
  else if (volUsd > 5000000) bonus += 5;
  if (tech && tech.snapshot.rsi14 > 78) bonus -= 8;
  if (!tech) bonus -= 5;
  if (ix.recoveryPct > 10) bonus -= Math.min((ix.recoveryPct - 10) * 0.7, 18);
  if (tech) {
    const ch = chaseAtrUnits(ix.currentPrice, ix.bottomPrice, tech.snapshot.atr14);
    if (ch != null) {
      if (ch < 1.3) bonus += 3;
      else if (ch > 3) bonus -= 5;
      else if (ch > 2) bonus -= 2;
    }
  }
  if (ix.recoveryPct < 1.2 && !ix.isRising) bonus -= 6;
  // New confluence signals
  if (ix.slopeLast6 != null) {
    if (ix.slopeLast6 > 0.6) bonus += 4;
    else if (ix.slopeLast6 < -0.6) bonus -= 4;
  }
  if (ix.obvAccum != null) {
    if (ix.obvAccum > 20) bonus += 3;
    else if (ix.obvAccum < -15) bonus -= 4;
  }
  if (ix.vShape != null) {
    if (ix.vShape >= 0.85) bonus += 3;
    else if (ix.vShape < 0.4) bonus -= 3;
  }
  if (tech && tech.snapshot.rsi14 > 82) bonus -= 10;
  if (tech && tech.squeeze) bonus += 4;
  if (ix.maxSpike != null) {
    if (ix.maxSpike > 12) bonus -= 5;
    else if (ix.maxSpike > 6) bonus -= 2;
  }

  const total = recComp + structComp + techComp + volQualComp + btcRelComp + bonus;
  const score = Math.max(0, Math.min(100, total));
  const breakdown = {
    recovery: Math.round(recComp * 10) / 10,
    structure: Math.round(structComp * 10) / 10,
    technical: Math.round(techComp * 10) / 10,
    volQuality: Math.round(volQualComp * 10) / 10,
    btcRel: Math.round(btcRelComp * 10) / 10,
    bonus: Math.round(bonus * 10) / 10,
  };

  const atrVal = tech ? tech.snapshot.atr14 : null;
  const chaseAtr = atrVal ? chaseAtrUnits(ix.currentPrice, ix.bottomPrice, atrVal) : null;
  const slPrice = ix.bottomPrice * 0.99;
  const risk = ix.currentPrice - slPrice;
  const tpPrice = risk > 0 ? ix.currentPrice + risk * 2 : null;

  return {
    coin,
    mode: 'intra',
    score: Math.round(score * 10) / 10,
    breakdown,
    currentPrice: ix.currentPrice,
    peakPrice: ix.peakPrice,
    bottomPrice: ix.bottomPrice,
    dropPct: Math.round(ix.dropPct * 100) / 100,
    recoveryPct: Math.round(ix.recoveryPct * 100) / 100,
    fromPeakPct: Math.round(ix.fromPeakPct * 100) / 100,
    hoursFromBottom: ix.hoursFromBottom,
    minutesFromBottom: null,
    daysFromBottom: null,
    isRising: ix.isRising,
    volIncrease: Math.round(ix.volIncrease * 100) / 100,
    volume24h: Math.round(volUsd),
    higherLows: ix.higherLows,
    greenLast5: ix.greenLast5,
    lowerWickPct: Math.round(ix.lowerWickPct * 1000) / 10,
    upDownVolRatio: Math.round(ix.upDownVolRatio * 100) / 100,
    slope: ix.slopeLast6 != null ? Math.round(ix.slopeLast6 * 100) / 100 : null,
    obvAccum: ix.obvAccum != null ? Math.round(ix.obvAccum * 10) / 10 : null,
    vShape: ix.vShape != null ? Math.round(ix.vShape * 100) / 100 : null,
    maxSpike: ix.maxSpike != null ? Math.round(ix.maxSpike * 10) / 10 : null,
    squeeze: tech ? !!tech.squeeze : null,
    coin12hReturn: Math.round(coin12h * 100) / 100,
    btc12hReturn: Math.round(btc12h * 100) / 100,
    relativeStrength: Math.round((coin12h - btc12h) * 100) / 100,
    rsi: tech ? Math.round(tech.snapshot.rsi14 * 10) / 10 : null,
    macdHist: tech ? tech.snapshot.macdHist : null,
    macdBullish: tech ? (tech.snapshot.macd > tech.snapshot.macdSignal) : null,
    emaStackBullish: tech ? (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) : null,
    bbPos: tech && (tech.snapshot.bbUpper - tech.snapshot.bbLower) > 0
      ? Math.round((tech.snapshot.close - tech.snapshot.bbLower) / (tech.snapshot.bbUpper - tech.snapshot.bbLower) * 100) / 100
      : null,
    atr: atrVal,
    heuristic: tech ? tech.heuristic : null,
    chaseAtr: chaseAtr != null ? Math.round(chaseAtr * 100) / 100 : null,
    slPrice: Math.round(slPrice * 1e8) / 1e8,
    tpPrice: tpPrice != null ? Math.round(tpPrice * 1e8) / 1e8 : null,
  };
}

async function scanOne(coin, volumeCache, btcContext, mode = 'swing') {
  if (mode === 'scalp') return scanOneScalp(coin, volumeCache, btcContext);
  if (mode === 'intra') return scanOneIntra(coin, volumeCache, btcContext);
  if (mode === 'quick') return scanOneQuick(coin, volumeCache, btcContext);
  return scanOneSwing(coin, volumeCache, btcContext);
}

async function scanAll(pairs, volumeCache, onProgress, mode = 'swing') {
  let btcContext;
  if (mode === 'scalp') {
    const btc15 = await fetchCoinbaseCandles('BTC', 900);
    btcContext = { btcReturn6h: computeBtcReturn6h(btc15) };
  } else if (mode === 'intra') {
    const btcHourly = await fetchCoinbaseCandles('BTC', 3600);
    btcContext = { btcReturn12h: computeBtcReturn12h(btcHourly) };
  } else if (mode === 'quick') {
    const btcHourly = await fetchCoinbaseCandles('BTC', 3600);
    btcContext = { btcReturn24h: computeBtcReturn24h(btcHourly) };
  } else {
    const btcDaily = await fetchCoinbaseCandles('BTC', 86400);
    btcContext = { btcReturn7d: computeBtcReturn7d(btcDaily) };
  }

  const out = [];
  const BATCH = mode === 'swing' ? 2 : 3;
  const DELAY = mode === 'scalp' ? 600 : mode === 'intra' ? 650 : mode === 'quick' ? 700 : 900;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(c => scanOne(c, volumeCache, btcContext, mode).catch(() => null)));
    results.forEach(r => { if (r) out.push(r); });
    if (onProgress) onProgress(i + batch.length, pairs.length);
    await sleep(DELAY);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { scanOne, scanAll, analyzeDaily, analyzeQuick, analyzeTechnical, compositeScore };
