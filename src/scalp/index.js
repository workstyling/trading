/**
 * SCALP SCORE — краткосрочный сигнал, горизонт 2-6 часов.
 * ────────────────────────────────────────────────────────────────────────
 * Веса и условия взяты из бэктеста на 28 252 сэмплах (109 монет, 7 дней,
 * свечи 5m, цель +1.38% / стоп −1.5%, проход вперёд без заглядывания).
 *
 * Что показал бэктест:
 *   • горизонт 20-60 минут НЕ РАБОТАЕТ: средний ход за час 0.177%,
 *     комиссия круга 0.25% — сигнал физически не окупает исполнение
 *     (ожидание базы −0.130% на сделку)
 *   • 3 часа — всё ещё минус (−0.038%)
 *   • 6 часов — впервые плюс (+0.014% база)
 *   • «купить провал» вредит и здесь: RSI<30 даёт −11пп, провал за 30мин −4пп,
 *     «у дна + объём» −6пп. То же, что на дневном горизонте.
 *   • лучшая связка: у дна 4ч диапазона + RSI вышел из перепроданности
 *     + цена выше EMA9 → 68% побед, ожидание +0.199% на сделку;
 *     на плохом отрезке рынка не теряет (−0.007%), на остальных +0.23 и +0.52%
 */

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
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

function ema(v, p) {
  if (v.length < p) return null;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}

/** Свечи 5m за последние сутки + производные сигналы */
async function fetchScalpSignals(coin) {
  let raw = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${CB}/products/${coin}-USD/candles?granularity=300`, H);
      if (r.status === 429) { await new Promise(x => setTimeout(x, 500 * (a + 1))); continue; }
      if (!r.ok) return null;
      raw = await r.json();
      break;
    } catch { await new Promise(x => setTimeout(x, 250)); }
  }
  if (!Array.isArray(raw) || raw.length < 60) return null;
  const c = raw.filter(x => Array.isArray(x) && x[4] > 0)
    .map(x => ({ t: x[0], low: x[1], high: x[2], open: x[3], close: x[4], vol: x[5] }))
    .sort((a, b) => a.t - b.t);
  if (c.length < 60) return null;

  const closes = c.map(x => x.close);
  const i = c.length - 1;
  const px = closes[i];
  const rsi = rsiSeries(closes, 14);
  const rNow = rsi[i];
  const rWin = rsi.slice(Math.max(0, i - 12), i + 1).filter(v => v != null);
  const rMin = rWin.length ? Math.min(...rWin) : null;

  const win48 = c.slice(Math.max(0, i - 48));       // 4 часа
  const lo = Math.min(...win48.map(x => x.low));
  const hi = Math.max(...win48.map(x => x.high));
  const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;

  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const vols = c.slice(Math.max(0, i - 48), i).map(x => x.vol);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volX = avgVol > 0 ? c[i].vol / avgVol : 0;

  return {
    price: px,
    rsi5: rNow != null ? Math.round(rNow * 10) / 10 : null,
    rsiMin1h: rMin != null ? Math.round(rMin * 10) / 10 : null,
    rsiRecover: rMin != null && rNow != null && rMin < 30 && rNow > rMin + 3,
    rangePos: Math.round(rangePos * 100) / 100,
    low4h: lo, high4h: hi,
    ema9: e9, ema21: e21,
    aboveE9: e9 != null && px > e9,
    e9overE21: e9 != null && e21 != null && e9 > e21,
    volX: Math.round(volX * 100) / 100,
  };
}

/**
 * Скоринг. Гейт из 4 условий — ровно та связка, что показала +0.199%
 * на сделку при 68% побед, плюс ликвидность (иначе исполнение съест сигнал).
 */
function calcScalpScore(s, vol24, spreadPct) {
  if (!s) return null;
  const liquid = vol24 >= 500e3;
  const checks = [
    { k: 'У дна 4ч диапазона (<25%)', ok: s.rangePos < 0.25, v: Math.round(s.rangePos * 100) + '%' },
    { k: 'RSI 5m вышел из ямы', ok: !!s.rsiRecover, v: `${s.rsi5 ?? '—'} (мин 1ч ${s.rsiMin1h ?? '—'})` },
    { k: 'Цена выше EMA9 (5m)', ok: !!s.aboveE9, v: s.aboveE9 ? 'да' : 'нет' },
    { k: 'Ликвидность ≥ $500K', ok: liquid, v: '$' + Math.round(vol24 / 1e3) + 'K' },
  ];
  const passed = checks.filter(x => x.ok).length;

  let sc = 0;
  if (s.rangePos < 0.25) sc += 25; else if (s.rangePos < 0.4) sc += 10; else if (s.rangePos > 0.9) sc -= 5;
  if (s.rsiRecover) sc += 25;
  else if (s.rsi5 != null && s.rsi5 < 30) sc += 5;      // ещё в яме — рано
  if (s.aboveE9) sc += 25;
  if (vol24 >= 2e6) sc += 15; else if (vol24 >= 1e6) sc += 13; else if (vol24 >= 500e3) sc += 11; else if (vol24 >= 250e3) sc += 5;
  if (s.e9overE21) sc += 5;
  if (s.volX >= 1.5) sc += 5;

  // Спред критичен: цель всего 1.38%, широкий спред съедает её на входе-выходе
  let wideSpread = false;
  if (spreadPct != null && spreadPct > 0.4) { sc -= 15; wideSpread = true; }

  if (!liquid) sc = Math.min(sc, 39);
  if (wideSpread) sc = Math.min(sc, 44);
  if (passed < 4 || wideSpread) sc = Math.min(sc, 74);   // 77+ ⇔ вход, как в REV
  sc = Math.max(0, Math.min(100, Math.round(sc)));

  let tag;
  if (!liquid) tag = 'НЕЛИКВИД';
  else if (wideSpread) tag = 'ШИРОКИЙ СПРЕД';
  else if (passed === 4) tag = 'ВХОД';
  else if (passed === 3) tag = 'БЛИЗКО';
  else tag = 'ЖДАТЬ';

  return {
    score: sc, tag, pass: passed === 4 && !wideSpread, passed, checks,
    rsi: s.rsi5, rangePos: s.rangePos, volX: s.volX,
    aboveE9: !!s.aboveE9, spreadPct: spreadPct != null ? Math.round(spreadPct * 100) / 100 : null,
  };
}

module.exports = { fetchScalpSignals, calcScalpScore, rsiSeries, ema };
