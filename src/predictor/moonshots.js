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

  return {
    currentPrice, peakPrice: maxPrice, bottomPrice: minPrice,
    dropPct, recoveryPct, fromPeakPct, daysFromBottom,
    isRising, volIncrease,
    higherLows, greenLast5, lowerWickPct, upDownVolRatio,
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
  return { snapshot: snap, heuristic: heur };
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
    structComp += Math.min(d.higherLows * 2.5, 10);     // 4+ higher lows = full 10
    structComp += d.greenLast5 * 1.5;                    // up to 7.5 for 5 green candles
    structComp += Math.min(d.lowerWickPct * 30, 5);      // 17% avg wick = full 5
  }

  // Technical component (0..20) — hourly state
  let techComp = 0;
  if (tech) {
    techComp += Math.max(0, tech.heuristic) * 0.25;   // 0..~20
    const r = tech.snapshot.rsi14;
    if (r >= 35 && r <= 60) techComp += 5;            // sweet spot: recovering from oversold
    else if (r > 75) techComp -= 5;                    // overbought = late
    if (tech.snapshot.macd > tech.snapshot.macdSignal) techComp += 3;
    if (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) techComp += 3;
  }

  // Volume quality (0..15) — up-day volume should dominate down-day volume
  let volQualComp = 0;
  if (d) {
    volQualComp = Math.min(Math.max(0, (d.upDownVolRatio - 1) * 7), 12);
    if (d.volIncrease > 1.5) volQualComp += 3;
  }

  // BTC-relative outperformance (0..15) — coin running while BTC is flat or down
  let btcRelComp = 0;
  if (d && btcReturn7d != null) {
    const coin7d = compute7dReturn(d.closes);
    const outperf = coin7d - btcReturn7d;
    if (outperf > 0) btcRelComp = Math.min(outperf * 0.5, 15);
  }

  // Liquidity bonus / trap penalty
  let bonus = 0;
  if (volUsd < 50000) bonus -= 25;
  else if (volUsd < 200000) bonus -= 10;
  else if (volUsd > 5000000) bonus += 5;
  // Trap filter: very overbought + already big recovery = late entry
  if (tech && tech.snapshot.rsi14 > 75 && d && d.recoveryPct > 50) bonus -= 8;
  // Penalty if hourly tech is missing
  if (!tech) bonus -= 5;

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

async function scanOne(coin, volumeCache, btcContext) {
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

  return {
    coin,
    score: Math.round(score * 10) / 10,
    breakdown,
    // Recovery slice
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
    // Structure slice
    higherLows: d.higherLows,
    greenLast5: d.greenLast5,
    lowerWickPct: Math.round(d.lowerWickPct * 1000) / 10, // %
    upDownVolRatio: Math.round(d.upDownVolRatio * 100) / 100,
    // BTC-relative
    coin7dReturn: Math.round(coin7d * 100) / 100,
    btc7dReturn: Math.round(btc7d * 100) / 100,
    relativeStrength: Math.round((coin7d - btc7d) * 100) / 100,
    // Technical slice
    rsi: tech ? Math.round(tech.snapshot.rsi14 * 10) / 10 : null,
    macdHist: tech ? tech.snapshot.macdHist : null,
    macdBullish: tech ? (tech.snapshot.macd > tech.snapshot.macdSignal) : null,
    emaStackBullish: tech ? (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) : null,
    bbPos: tech && (tech.snapshot.bbUpper - tech.snapshot.bbLower) > 0
      ? Math.round((tech.snapshot.close - tech.snapshot.bbLower) / (tech.snapshot.bbUpper - tech.snapshot.bbLower) * 100) / 100
      : null,
    atr: tech ? tech.snapshot.atr14 : null,
    heuristic: tech ? tech.heuristic : null,
  };
}

async function scanAll(pairs, volumeCache, onProgress) {
  // Fetch BTC reference once at start so every coin can compute relative strength
  const btcDaily = await fetchCoinbaseCandles('BTC', 86400);
  const btcContext = { btcReturn7d: computeBtcReturn7d(btcDaily) };

  const out = [];
  const BATCH = 2;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(c => scanOne(c, volumeCache, btcContext).catch(() => null)));
    results.forEach(r => { if (r) out.push(r); });
    if (onProgress) onProgress(i + batch.length, pairs.length);
    await sleep(900);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { scanOne, scanAll, analyzeDaily, analyzeTechnical, compositeScore };
