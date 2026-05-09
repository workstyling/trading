// Combined "moonshot" scanner: finds coins that look ready to fly.
// Per coin we run TWO analyses in parallel:
//   - daily candles (30d) for recovery pattern: drop magnitude, bounce off bottom, days from bottom, volume surge
//   - 1h candles (200) for technical state: RSI, MACD, EMA stack, Bollinger, ATR — same path as the Predictor
// We then merge into a single composite score (0..100) so the user gets one ranked list.

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

// ── Recovery analysis on daily candles (30d) ──
function analyzeRecovery(dailyRaw) {
  // Coinbase daily rows: [time, low, high, open, close, volume] — newest first
  const sorted = dailyRaw.slice(0, 30).reverse();
  const closes = sorted.map(c => parseFloat(c[4]));
  const volumes = sorted.map(c => parseFloat(c[5]));
  if (closes.length < 10) return null;

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

  // Last 3 days trend
  const last3 = closes.slice(-3);
  const isRising = last3.length >= 3 && last3[2] > last3[0];

  // Volume surge
  const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const prevVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
  const volIncrease = prevVol > 0 ? recentVol / prevVol : 1;

  // Recovery score (same shape as the standalone recovery scanner)
  const freshBonus = daysFromBottom <= 6 ? 15 : daysFromBottom <= 10 ? 8 : 0;
  const volScore = Math.min(volIncrease * 12, 30);
  const trendScore = isRising ? 20 : 0;
  const dropScore = Math.min(Math.abs(dropPct) * 0.2, 15);
  const recoveryScore = Math.min(recoveryPct * 0.3, 15);
  const recoveryTotal = volScore + trendScore + freshBonus + dropScore + recoveryScore;

  return {
    currentPrice,
    peakPrice: maxPrice,
    bottomPrice: minPrice,
    dropPct,
    recoveryPct,
    fromPeakPct,
    daysFromBottom,
    isRising,
    volIncrease,
    recoveryScore: recoveryTotal,
  };
}

// ── Technical analysis on hourly candles (~200) ──
function analyzeTechnical(hourlyRaw) {
  const sorted = hourlyRaw.slice().reverse(); // oldest to newest
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
  // Find the latest valid index where features can be built
  let i = candles.length - 1;
  let v = null;
  while (i >= 0 && !(v = vectorAt(ind, i))) i--;
  if (!v) return null;

  const snap = snapshotAt(ind, i);
  const heur = heuristicScore(snap);
  const heurProb = 0.5 + Math.tanh(heur / 60) * 0.5;

  return { snapshot: snap, heuristic: heur, heurProb };
}

// ── Composite scoring ──
function compositeScore(rec, tech, volUsd) {
  // Recovery component (0..~95)
  const recComp = rec ? Math.max(0, rec.recoveryScore) : 0;

  // Technical component (0..~50)
  let techComp = 0;
  if (tech) {
    // Heuristic-driven: positive heur = bullish setup
    techComp += Math.max(0, tech.heuristic) * 0.4; // 0..40
    // RSI bonus: prefer 35-55 (recovering from oversold)
    const r = tech.snapshot.rsi14;
    if (r >= 30 && r <= 55) techComp += 10;
    else if (r > 70) techComp -= 8;
  }

  // Liquidity (penalize illiquid)
  let liqPenalty = 0;
  if (volUsd < 50000) liqPenalty = -25;
  else if (volUsd < 200000) liqPenalty = -10;
  else if (volUsd > 5000000) liqPenalty = 5;

  return Math.max(0, Math.min(100, recComp + techComp + liqPenalty));
}

async function scanOne(coin, volumeCache) {
  const [daily, hourly] = await Promise.all([
    fetchCoinbaseCandles(coin, 86400),
    fetchCoinbaseCandles(coin, 3600),
  ]);
  if (!daily) return null;

  const rec = analyzeRecovery(daily);
  if (!rec) return null;

  // Filter: meaningful drop AND some recovery AND fresh bottom
  if (!(rec.dropPct < -12 && rec.recoveryPct > 1 && rec.daysFromBottom > 0 && rec.daysFromBottom <= 25)) {
    return null;
  }

  const tech = hourly ? analyzeTechnical(hourly) : null;
  const volUsd = volumeCache?.get(coin) || 0;
  const score = compositeScore(rec, tech, volUsd);

  return {
    coin,
    score: Math.round(score * 10) / 10,
    // Recovery slice
    currentPrice: rec.currentPrice,
    peakPrice: rec.peakPrice,
    bottomPrice: rec.bottomPrice,
    dropPct: Math.round(rec.dropPct * 100) / 100,
    recoveryPct: Math.round(rec.recoveryPct * 100) / 100,
    fromPeakPct: Math.round(rec.fromPeakPct * 100) / 100,
    daysFromBottom: rec.daysFromBottom,
    isRising: rec.isRising,
    volIncrease: Math.round(rec.volIncrease * 100) / 100,
    volume24h: Math.round(volUsd),
    // Technical slice (may be null if hourly fetch failed)
    rsi: tech ? Math.round(tech.snapshot.rsi14 * 10) / 10 : null,
    macdHist: tech ? tech.snapshot.macdHist : null,
    macdBullish: tech ? (tech.snapshot.macd > tech.snapshot.macdSignal) : null,
    emaStackBullish: tech ? (tech.snapshot.ema9 > tech.snapshot.ema21 && tech.snapshot.ema21 > tech.snapshot.ema55) : null,
    bbPos: tech ? (tech.snapshot.bbUpper - tech.snapshot.bbLower > 0
      ? (tech.snapshot.close - tech.snapshot.bbLower) / (tech.snapshot.bbUpper - tech.snapshot.bbLower)
      : 0.5) : null,
    atr: tech ? tech.snapshot.atr14 : null,
    heuristic: tech ? tech.heuristic : null,
    heurProb: tech ? Math.round(tech.heurProb * 1000) / 1000 : null,
  };
}

async function scanAll(pairs, volumeCache, onProgress) {
  const out = [];
  const BATCH = 2;
  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(c => scanOne(c, volumeCache).catch(() => null)));
    results.forEach(r => { if (r) out.push(r); });
    if (onProgress) onProgress(i + batch.length, pairs.length);
    await sleep(900);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { scanOne, scanAll, analyzeRecovery, analyzeTechnical, compositeScore };
