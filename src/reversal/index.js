/**
 * 30D CRASH → REVERSAL SCORE (0-100)
 * ────────────────────────────────────────────────────────────────────────
 * Ищет не «самую упавшую» монету, а ту, где продавцы начали выдыхаться:
 * сильное падение + капитуляционный объём + первые доказательства разворота
 * (bullish divergence, higher low, пробой локального lower high).
 *
 * Двухступенчатая логика скоринга:
 *   OVERSOLD (насколько продавили)      — 40 баллов
 *   CONFIRMATION (разворот подтверждён) — 55 баллов  ← весит больше
 *   MARKET REGIME (BTC не валится)      —  5 баллов
 *
 * Coinbase не отдаёт 4H-свечи (granularity: 60/300/900/3600/21600/86400),
 * поэтому 4H собираем агрегацией часовых.
 */

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };

const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'GUSD', 'USDP', 'FRAX', 'LUSD',
  'CRVUSD', 'PYUSD', 'EURC', 'FDUSD', 'USDS', 'USDM', 'ALUSD', 'SUSD', 'MUSD', 'DOLA', 'RAI',
  'EUR', 'GBP', 'CBETH', 'WBTC', 'PAXG']);

// ── Пороги первичного фильтра ──
const FILTERS = {
  mcapMin: 20e6,
  mcapMax: 5e9,
  vol24Min: 500e3,
  volToMcapMin: 0.02,   // 2%
  drop30dMax: -30,      // ≤ −30%
  priceMin: 0.00001,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ════════════════ Индикаторы ════════════════

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Свечи Coinbase [time, low, high, open, close, volume], newest first → сортируем по возрастанию */
function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(c => Array.isArray(c) && c.length >= 6 && c[4] > 0)
    .map(c => ({ t: c[0], low: c[1], high: c[2], open: c[3], close: c[4], vol: c[5] }))
    .sort((a, b) => a.t - b.t);
}

/** Часовые свечи → 4H (Coinbase не отдаёт granularity=14400) */
function aggregateTo4H(hourly) {
  const out = [];
  for (let i = 0; i < hourly.length; i += 4) {
    const chunk = hourly.slice(i, i + 4);
    if (chunk.length < 4 && i + 4 <= hourly.length) continue;
    if (!chunk.length) continue;
    out.push({
      t: chunk[0].t,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      vol: chunk.reduce((a, c) => a + c.vol, 0),
    });
  }
  return out;
}

/** Свинг-лоу: минимум, подтверждённый w свечами с каждой стороны */
function swingLows(candles, w = 2) {
  const out = [];
  for (let i = w; i < candles.length - w; i++) {
    let isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j !== i && candles[j].low < candles[i].low) { isLow = false; break; }
    }
    if (isLow) out.push(i);
  }
  return out;
}

function swingHighs(candles, w = 2) {
  const out = [];
  for (let i = w; i < candles.length - w; i++) {
    let isHigh = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j !== i && candles[j].high > candles[i].high) { isHigh = false; break; }
    }
    if (isHigh) out.push(i);
  }
  return out;
}

// ════════════════ Детекторы разворота (на 4H) ════════════════

/**
 * Bullish divergence: цена сделала более низкий low, а RSI — более высокий.
 * Значит давление продавцов слабеет, несмотря на новую низкую цену.
 */
function detectDivergence(c4, rsi4, lookback = 42) {
  const from = Math.max(0, c4.length - lookback);
  const window = c4.slice(from);
  const lows = swingLows(window, 2).map(i => i + from);
  if (lows.length < 2) return { found: false };
  // берём два последних свинг-лоу, где RSI посчитан
  const valid = lows.filter(i => rsi4[i] != null);
  if (valid.length < 2) return { found: false };
  const i2 = valid[valid.length - 1], i1 = valid[valid.length - 2];
  const p1 = c4[i1].low, p2 = c4[i2].low;
  const r1 = rsi4[i1], r2 = rsi4[i2];
  const priceLower = p2 < p1 * 0.998;         // новый low по цене (мин. 0.2% ниже)
  const rsiHigher = r2 > r1 + 1.5;            // но RSI выше
  return {
    found: priceLower && rsiHigher,
    p1, p2, r1: Math.round(r1 * 10) / 10, r2: Math.round(r2 * 10) / 10,
    barsAgo: c4.length - 1 - i2,
    strength: priceLower && rsiHigher ? Math.min(1, (r2 - r1) / 12) : 0,
  };
}

/**
 * Higher Low: после самого низкого свинг-лоу окна сформировался следующий,
 * который ВЫШЕ — структура падения сломана.
 */
function detectHigherLow(c4, lookback = 42) {
  const from = Math.max(0, c4.length - lookback);
  const window = c4.slice(from);
  const lows = swingLows(window, 2).map(i => i + from);
  if (lows.length < 2) return { found: false };
  let botIdx = lows[0];
  for (const i of lows) if (c4[i].low < c4[botIdx].low) botIdx = i;
  const after = lows.filter(i => i > botIdx);
  if (!after.length) return { found: false, bottomBarsAgo: c4.length - 1 - botIdx };
  const hl = after[after.length - 1];
  const higher = c4[hl].low > c4[botIdx].low * 1.005; // выше дна минимум на 0.5%
  const priceHolds = c4[c4.length - 1].close > c4[hl].low; // цена всё ещё выше этого HL
  return {
    found: higher && priceHolds,
    bottom: c4[botIdx].low,
    hlPrice: c4[hl].low,
    liftPct: Math.round((c4[hl].low / c4[botIdx].low - 1) * 1000) / 10,
    bottomBarsAgo: c4.length - 1 - botIdx,
    hlBarsAgo: c4.length - 1 - hl,
  };
}

/**
 * Breakout: цена пробила последний локальный lower high (тот, что был между дном и сейчас).
 */
function detectBreakout(c4, lookback = 42) {
  const from = Math.max(0, c4.length - lookback);
  const window = c4.slice(from);
  const highs = swingHighs(window, 2).map(i => i + from);
  if (!highs.length) return { found: false };
  const price = c4[c4.length - 1].close;
  // ближайший подтверждённый свинг-хай за последние 2 свечи не берём (не подтверждён)
  const usable = highs.filter(i => i <= c4.length - 3);
  if (!usable.length) return { found: false };
  const lastHigh = c4[usable[usable.length - 1]].high;
  return {
    found: price > lastHigh,
    level: lastHigh,
    distPct: Math.round((price / lastHigh - 1) * 1000) / 10,
    barsAgo: c4.length - 1 - usable[usable.length - 1],
  };
}

/** Капитуляционная свеча: огромный объём + длинная нижняя тень + закрытие в верхней половине */
function detectCapitulation(c4, lookback = 30) {
  const from = Math.max(0, c4.length - lookback);
  const window = c4.slice(from);
  if (window.length < 10) return { found: false };
  const avgVol = window.slice(0, -1).reduce((a, c) => a + c.vol, 0) / (window.length - 1);
  for (let k = window.length - 1; k >= Math.max(0, window.length - 8); k--) {
    const c = window[k];
    const range = c.high - c.low;
    if (range <= 0 || avgVol <= 0) continue;
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const closePos = (c.close - c.low) / range; // 1 = закрылась на хаях
    if (c.vol / avgVol >= 2 && lowerWick / range >= 0.4 && closePos >= 0.5) {
      return { found: true, volX: Math.round(c.vol / avgVol * 10) / 10, barsAgo: window.length - 1 - k };
    }
  }
  return { found: false };
}

// ════════════════ Скоринг 0-100 ════════════════

function scoreCoin(m) {
  const parts = [];
  const add = (pts, max, label) => { parts.push({ label, pts: Math.round(pts * 10) / 10, max }); return pts; };
  let s = 0;

  // ── OVERSOLD: насколько продавили (40) ──
  // 1. Ликвидность (15) — не «чем больше, тем лучше», а достаточность + активность к капе
  let liq = 0;
  if (m.vol24 >= 5e6) liq += 8; else if (m.vol24 >= 2e6) liq += 7; else if (m.vol24 >= 1e6) liq += 5.5; else if (m.vol24 >= 500e3) liq += 4;
  const vmc = m.volToMcap;
  if (vmc >= 0.30) liq += 3;            // подозрительно высоко — может быть аномалия
  else if (vmc >= 0.15) liq += 6;
  else if (vmc >= 0.05) liq += 7;
  else if (vmc >= 0.02) liq += 4.5;
  s += add(liq, 15, 'Ликвидность');

  // 2. Глубина падения (15)
  let drop = 0;
  const d30 = m.pct30d;
  if (d30 <= -55) drop = 15; else if (d30 <= -45) drop = 13; else if (d30 <= -35) drop = 11; else if (d30 <= -30) drop = 8;
  if (m.pct60d != null && m.pct60d <= -40) drop = Math.min(15, drop + 1.5); // подтверждение длинного тренда вниз
  s += add(drop, 15, 'Сила падения');

  // 3. Oversold RSI (10) — важен не только уровень, но и разворот вверх
  let os = 0;
  const r = m.rsi4h;
  if (r != null) {
    if (r < 25) os = 7; else if (r < 30) os = 6; else if (r < 35) os = 5; else if (r < 45) os = 3; else if (r < 55) os = 1.5;
    if (m.rsiMin7d != null && m.rsiMin7d < 30 && r > m.rsiMin7d + 4) os += 3; // был в яме и начал вылезать
  }
  s += add(Math.min(10, os), 10, 'Oversold RSI');

  // ── CONFIRMATION: продавцы теряют контроль (55) ──
  // 4. Volume spike (15) — капитуляция/приход покупателя
  let vs = 0;
  const x = m.volSpike;
  if (x >= 3) vs = 15; else if (x >= 2) vs = 12; else if (x >= 1.5) vs = 8; else if (x >= 1.2) vs = 4;
  if (m.capitulation && m.capitulation.found) vs = Math.min(15, vs + 3);
  s += add(vs, 15, 'Объём/капитуляция');

  // 5. Bullish divergence (15) — самый ранний признак
  const dv = m.divergence;
  s += add(dv && dv.found ? 9 + 6 * dv.strength : 0, 15, 'Bullish divergence');

  // 6. Higher Low (15) — структура падения сломана
  let hlPts = 0;
  const hl = m.higherLow;
  if (hl && hl.found) {
    hlPts = 11;
    if (hl.liftPct >= 3) hlPts += 2;
    if (hl.bottomBarsAgo >= 3 && hl.bottomBarsAgo <= 25) hlPts += 2; // дно свежее, но уже подтверждено
  }
  s += add(Math.min(15, hlPts), 15, 'Higher Low');

  // 7. Breakout + EMA20 (10)
  let bo = 0;
  if (m.breakout && m.breakout.found) bo += 6;
  if (m.aboveEma20_4h) bo += 4;
  s += add(bo, 10, 'Breakout / EMA20');

  // ── MARKET REGIME (5) ──
  let btc = 0;
  if (m.btc) {
    if (m.btc.aboveEma20) btc += 3;
    if (m.btc.pct4h > 0) btc += 2;
    else if (m.btc.pct4h < -1.5) btc -= 2; // рынок валится — альту не дадут развернуться
  }
  s += add(btc, 5, 'BTC regime');

  const score = Math.max(0, Math.min(100, Math.round(s)));
  // Разбиение на две половины — главная идея: подтверждение важнее «продавленности»
  const oversoldScore = Math.round(parts.slice(0, 3).reduce((a, p) => a + p.pts, 0));
  const confirmScore = Math.round(parts.slice(3, 7).reduce((a, p) => a + p.pts, 0));

  let verdict;
  if (score >= 85) verdict = '🚨 РЕДКИЙ СИГНАЛ';
  else if (score >= 75) verdict = '🔥 СИЛЬНЫЙ СИГНАЛ';
  else if (score >= 65) verdict = '✅ ИНТЕРЕСНЫЙ';
  else if (score >= 50) verdict = '👀 НАБЛЮДАТЬ';
  else verdict = '❌ ИГНОР';

  // Отдельный стоп-флаг: падает без единого признака разворота = падающий нож
  const noConfirm = confirmScore < 12;
  if (noConfirm) verdict = '🔪 ПАДАЮЩИЙ НОЖ';

  return { score, oversoldScore, confirmScore, verdict, parts, noConfirm };
}

// ════════════════ Загрузка данных ════════════════

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, H);
      if (r.status === 429) { await sleep(700 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(300); }
  }
  return null;
}

async function getBtcRegime() {
  const raw = await fetchJson(`${CB}/products/BTC-USD/candles?granularity=3600`);
  const hourly = normalizeCandles(raw);
  if (hourly.length < 100) return null;
  const c4 = aggregateTo4H(hourly);
  const closes = c4.map(c => c.close);
  const e20 = ema(closes, 20);
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  return {
    price,
    aboveEma20: e20 != null && price > e20,
    pct4h: prev ? Math.round((price / prev - 1) * 1000) / 10 : 0,
  };
}

/** Шаг 1: дневные свечи — падение, объёмы. Дёшево, гоняем по всем кандидатам. */
async function fetchDaily(coin) {
  const now = Date.now();
  const start = new Date(now - 65 * 86400 * 1000).toISOString();
  const end = new Date(now).toISOString();
  const raw = await fetchJson(`${CB}/products/${coin}-USD/candles?granularity=86400&start=${start}&end=${end}`);
  const cd = normalizeCandles(raw);
  if (cd.length < 25) return null;
  const closes = cd.map(c => c.close);
  const price = closes[closes.length - 1];
  const n = closes.length;
  const i30 = Math.max(0, n - 31), i60 = 0;
  const pct30d = closes[i30] ? (price / closes[i30] - 1) * 100 : null;
  const pct60d = n >= 55 && closes[i60] ? (price / closes[i60] - 1) * 100 : null;
  // объёмы в USD
  const volsUsd = cd.map(c => c.vol * c.close);
  const vol24 = volsUsd[volsUsd.length - 1];
  const prev30 = volsUsd.slice(-31, -1);
  const avgVol30 = prev30.length ? prev30.reduce((a, b) => a + b, 0) / prev30.length : 0;
  const lows = cd.map(c => c.low);
  const low30 = Math.min(...lows.slice(-30));
  let lowIdx = 0;
  for (let i = Math.max(0, n - 30); i < n; i++) if (cd[i].low <= low30) lowIdx = i;
  return {
    price, pct30d, pct60d, vol24, avgVol30,
    volSpike: avgVol30 > 0 ? vol24 / avgVol30 : 0,
    low30, daysFromLow: n - 1 - lowIdx,
    fromLowPct: low30 > 0 ? (price / low30 - 1) * 100 : 0,
  };
}

/** Шаг 2: часовые → 4H, вся механика разворота. Только для прошедших фильтр. */
async function fetchReversalSignals(coin) {
  const raw = await fetchJson(`${CB}/products/${coin}-USD/candles?granularity=3600`);
  const hourly = normalizeCandles(raw);
  if (hourly.length < 80) return null;
  const c4 = aggregateTo4H(hourly);
  if (c4.length < 30) return null;
  const closes = c4.map(c => c.close);
  const rsi4 = rsiSeries(closes, 14);
  const rsi4h = rsi4[rsi4.length - 1];
  const last42 = rsi4.slice(-42).filter(v => v != null);
  const rsiMin7d = last42.length ? Math.min(...last42) : null;
  const e20 = ema(closes, 20);
  return {
    rsi4h: rsi4h != null ? Math.round(rsi4h * 10) / 10 : null,
    rsiMin7d: rsiMin7d != null ? Math.round(rsiMin7d * 10) / 10 : null,
    aboveEma20_4h: e20 != null && closes[closes.length - 1] > e20,
    ema20_4h: e20,
    divergence: detectDivergence(c4, rsi4),
    higherLow: detectHigherLow(c4),
    breakout: detectBreakout(c4),
    capitulation: detectCapitulation(c4),
  };
}

/**
 * Полный скан.
 * @param mcapMap { SYM: {mc, px} } из CryptoRank
 * @param onProgress (stage, done, total)
 */
async function scan(mcapMap, onProgress = () => {}, opts = {}) {
  const f = { ...FILTERS, ...opts };
  const products = await fetchJson(`${CB}/products`);
  const pairs = (Array.isArray(products) ? products : [])
    .filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map(p => p.base_currency)
    .filter(sym => !STABLECOINS.has(sym));

  // Первичный отсев по market cap (бесплатно, из карты)
  const byMcap = pairs.filter(sym => {
    const mc = mcapMap[sym]?.mc || 0;
    return mc >= f.mcapMin && mc <= f.mcapMax;
  });

  const stats = { pairs: pairs.length, byMcap: byMcap.length, dailyOk: 0, passedFilter: 0 };
  const candidates = [];

  // Шаг 1 — дневные свечи
  for (let i = 0; i < byMcap.length; i += 2) {
    const batch = byMcap.slice(i, i + 2);
    await Promise.all(batch.map(async sym => {
      const d = await fetchDaily(sym);
      if (!d) return;
      stats.dailyOk++;
      const mc = mcapMap[sym].mc;
      const crPx = mcapMap[sym].px;
      // защита от коллизии тикеров (другой проект с тем же символом)
      if (crPx > 0 && (d.price / crPx > 2.5 || crPx / d.price > 2.5)) return;
      const volToMcap = mc > 0 ? d.vol24 / mc : 0;
      if (d.price < f.priceMin) return;
      if (d.pct30d == null || d.pct30d > f.drop30dMax) return;
      if (d.vol24 < f.vol24Min) return;
      if (volToMcap < f.volToMcapMin) return;
      stats.passedFilter++;
      candidates.push({ coin: sym, mcap: mc, volToMcap, ...d });
    }));
    onProgress('daily', Math.min(i + 2, byMcap.length), byMcap.length);
    await sleep(220);
  }

  // Шаг 2 — механика разворота только для прошедших
  const btc = await getBtcRegime();
  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const sig = await fetchReversalSignals(c.coin);
    if (sig) {
      const m = { ...c, ...sig, btc };
      const sc = scoreCoin(m);
      results.push({ ...m, ...sc });
    }
    onProgress('signals', i + 1, candidates.length);
    await sleep(180);
  }

  results.sort((a, b) => b.score - a.score);
  return { results, stats, btc, filters: f, at: Date.now() };
}

module.exports = {
  scan, scoreCoin, FILTERS, STABLECOINS,
  rsiSeries, ema, aggregateTo4H, normalizeCandles,
  detectDivergence, detectHigherLow, detectBreakout, detectCapitulation,
  fetchDaily, fetchReversalSignals, getBtcRegime,
};
