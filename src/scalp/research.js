/**
 * Исследование двух гипотез перед тем, как встраивать их в систему:
 *
 *  1. ВОЗРАСТ СИГНАЛА — важно ли, что гейт закрылся только что, а не 3 часа назад?
 *  2. РЕЖИМ РЫНКА — можно ли отсечь периоды, когда не работает ничего?
 *
 * Метод тот же: свечи 5m, проход вперёд, барьер +1.38% / −1.5% на 6 часов,
 * зависшие закрываются по рынку, комиссия круга 0.25%.
 *
 * Запуск: node src/scalp/research.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 7;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 1.38, SL = 1.5, FEE = 0.25;
const HORIZON = 72;           // 6 часов в 5m-барах
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STABLE = new Set(['USDT','USDC','DAI','BUSD','TUSD','GUSD','USDP','FRAX','LUSD','CRVUSD',
  'PYUSD','EURC','FDUSD','USDS','USDM','SUSD','DOLA','RAI','EUR','GBP','CBETH','PAXG','WBTC']);

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
function emaSeries(v, p) {
  const out = new Array(v.length).fill(null);
  if (v.length < p) return out;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, H);
      if (r.status === 429) { await sleep(600 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(250); }
  }
  return null;
}
async function fetch5m(coin, days) {
  const out = [];
  let end = Date.now();
  const pages = Math.ceil(days * 24 * 12 / 300);
  for (let p = 0; p < pages; p++) {
    const start = end - 300 * 300 * 1000;
    const d = await fetchJson(`${CB}/products/${coin}-USD/candles?granularity=300&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (Array.isArray(d) && d.length) out.push(...d); else break;
    end = start;
    await sleep(110);
  }
  return out.filter(c => Array.isArray(c) && c[4] > 0)
    .map(c => ({ t: c[0], low: c[1], high: c[2], open: c[3], close: c[4], vol: c[5] }))
    .sort((a, b) => a.t - b.t);
}

/** Гейт скальпа в баре i — ровно тот, что в проде */
function gateAt(c, i, closes, rsi, e9) {
  if (i < 60) return false;
  const px = closes[i];
  const win = c.slice(i - 48, i + 1);
  const lo = Math.min(...win.map(x => x.low)), hi = Math.max(...win.map(x => x.high));
  const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;
  const rWin = rsi.slice(i - 12, i + 1).filter(v => v != null);
  if (!rWin.length) return false;
  const rMin = Math.min(...rWin), rNow = rsi[i];
  const recover = rMin < 30 && rNow != null && rNow > rMin + 3;
  const aboveE9 = e9[i] != null && px > e9[i];
  return rangePos < 0.25 && recover && aboveE9;
}

function outcome(c, i) {
  const entry = c[i].close;
  let hit = null, stop = null;
  for (let j = i + 1; j <= Math.min(i + HORIZON, c.length - 1); j++) {
    if (stop === null && c[j].low / entry - 1 <= -SL / 100) stop = j - i;
    if (hit === null && c[j].high / entry - 1 >= TP / 100) hit = j - i;
    if (hit !== null || stop !== null) break;
  }
  const last = Math.min(i + HORIZON, c.length - 1);
  const mkt = (c[last].close / entry - 1) * 100;
  if (hit != null && (stop == null || hit < stop)) return { r: 1, pnl: TP - FEE };
  if (stop != null) return { r: 0, pnl: -SL - FEE };
  return { r: null, pnl: mkt - FEE };
}

const agg = rows => {
  if (!rows.length) return null;
  const res = rows.filter(x => x.r != null);
  const w = res.filter(x => x.r === 1).length;
  return {
    n: rows.length,
    win: res.length ? Math.round(w / res.length * 100) : null,
    exp: Math.round(rows.reduce((a, x) => a + x.pnl, 0) / rows.length * 1000) / 1000,
  };
};

(async () => {
  const t0 = Date.now();
  console.log('Вселенная...');
  const products = await fetchJson(`${CB}/products`);
  const pairs = (products || []).filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map(p => p.base_currency).filter(s => !STABLE.has(s));
  const uni = [];
  for (let i = 0; i < pairs.length; i += 25) {
    const st = await Promise.all(pairs.slice(i, i + 25).map(async c => {
      const s = await fetchJson(`${CB}/products/${c}-USD/stats`, 1);
      if (!s) return null;
      const vol = (parseFloat(s.volume) || 0) * (parseFloat(s.last) || 0);
      return vol >= MIN_VOL ? { coin: c, vol } : null;
    }));
    uni.push(...st.filter(Boolean));
    await sleep(150);
  }
  uni.sort((a, b) => b.vol - a.vol);
  const coins = uni.slice(0, 110).map(x => x.coin);
  console.log(`${coins.length} монет, ${DAYS} дней\n`);

  // BTC как индикатор режима: карта время → состояние
  console.log('BTC для режима...');
  const btc = await fetch5m('BTC', DAYS);
  const btcCloses = btc.map(x => x.close);
  const btcE = emaSeries(btcCloses, 240);   // EMA20 на часовом ≈ 240 баров по 5m
  const btcMap = new Map();
  for (let i = 24; i < btc.length; i++) {
    btcMap.set(btc[i].t, {
      above: btcE[i] != null && btcCloses[i] > btcE[i],
      pct2h: btcCloses[i - 24] ? (btcCloses[i] / btcCloses[i - 24] - 1) * 100 : 0,
    });
  }
  console.log(`BTC: ${btcMap.size} баров\n`);

  const S = [];
  for (let ci = 0; ci < coins.length; ci++) {
    const c = await fetch5m(coins[ci], DAYS);
    if (c.length < 600) { process.stdout.write('.'); continue; }
    const closes = c.map(x => x.close);
    const rsi = rsiSeries(closes, 14);
    const e9 = emaSeries(closes, 9);
    let openSince = null;     // бар, на котором гейт закрылся
    for (let i = 60; i < c.length - HORIZON; i++) {
      const g = gateAt(c, i, closes, rsi, e9);
      if (!g) { openSince = null; continue; }
      if (openSince === null) openSince = i;
      const age = i - openSince;                 // 0 = только что сработал
      const o = outcome(c, i);
      // ближайший бар BTC (та же сетка 5m)
      const b = btcMap.get(c[i].t) || null;
      S.push({ coin: coins[ci], t: c[i].t, age, ...o, btcAbove: b ? b.above : null, btcPct2h: b ? b.pct2h : null });
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('•');
  }

  console.log(`\n\nСигналов гейта: ${S.length} · время ${Math.round((Date.now() - t0) / 1000)}с`);
  const base = agg(S);
  console.log(`ВСЕ: n=${base.n} win ${base.win}% ожидание ${base.exp >= 0 ? '+' : ''}${base.exp}%\n`);

  // ── 1. ВОЗРАСТ ──
  console.log('═'.repeat(76));
  console.log('  1. ВОЗРАСТ СИГНАЛА (сколько 5м-баров гейт уже открыт)');
  console.log('═'.repeat(76));
  console.log('  ВОЗРАСТ            N     WIN%    ОЖИДАНИЕ    vs ВСЕ');
  console.log('  ' + '─'.repeat(70));
  for (const [lo, hi, lbl] of [[0, 1, 'только что (0)'], [1, 3, '5–10 минут'], [3, 6, '15–25 минут'],
                                [6, 12, '30–55 минут'], [12, 24, '1–2 часа'], [24, 9999, 'больше 2 часов']]) {
    const a = agg(S.filter(x => x.age >= lo && x.age < hi));
    if (!a || a.n < 40) { console.log(`  ${lbl.padEnd(18)} ${String(a ? a.n : 0).padStart(5)}   мало данных`); continue; }
    const d = Math.round((a.exp - base.exp) * 1000) / 1000;
    console.log(`  ${lbl.padEnd(18)} ${String(a.n).padStart(5)}   ${String(a.win).padStart(3)}%   ${((a.exp >= 0 ? '+' : '') + a.exp + '%').padStart(9)}   ${((d >= 0 ? '+' : '') + d).padStart(7)}`);
  }

  // ── 2. РЕЖИМ ──
  console.log('\n' + '═'.repeat(76));
  console.log('  2. РЕЖИМ РЫНКА ПО BTC');
  console.log('═'.repeat(76));
  const withB = S.filter(x => x.btcAbove != null);
  console.log(`  сэмплов с данными BTC: ${withB.length}\n`);
  console.log('  РЕЖИМ                          N     WIN%    ОЖИДАНИЕ    vs ВСЕ');
  console.log('  ' + '─'.repeat(70));
  const regimes = {
    'BTC выше EMA20 (1ч)': x => x.btcAbove,
    'BTC ниже EMA20 (1ч)': x => !x.btcAbove,
    'BTC растёт за 2ч': x => x.btcPct2h > 0.1,
    'BTC стоит (±0.1%)': x => Math.abs(x.btcPct2h) <= 0.1,
    'BTC падает за 2ч': x => x.btcPct2h < -0.1,
    'BTC падает >0.5% за 2ч': x => x.btcPct2h < -0.5,
    'выше EMA20 + растёт': x => x.btcAbove && x.btcPct2h > 0.1,
    'ниже EMA20 + падает': x => !x.btcAbove && x.btcPct2h < -0.1,
  };
  for (const [name, fn] of Object.entries(regimes)) {
    const a = agg(withB.filter(fn));
    if (!a || a.n < 40) { console.log(`  ${name.padEnd(30)} ${String(a ? a.n : 0).padStart(5)}   мало данных`); continue; }
    const d = Math.round((a.exp - base.exp) * 1000) / 1000;
    console.log(`  ${name.padEnd(30)} ${String(a.n).padStart(5)}   ${String(a.win).padStart(3)}%   ${((a.exp >= 0 ? '+' : '') + a.exp + '%').padStart(9)}   ${((d >= 0 ? '+' : '') + d).padStart(7)}`);
  }

  // ── 3. КОМБИНАЦИЯ ──
  console.log('\n' + '═'.repeat(76));
  console.log('  3. СВЕЖИЙ СИГНАЛ + ХОРОШИЙ РЕЖИМ');
  console.log('═'.repeat(76));
  for (const [name, fn] of Object.entries({
    'свежий (≤10 мин)': x => x.age < 3,
    'свежий + BTC выше EMA20': x => x.age < 3 && x.btcAbove,
    'свежий + BTC не падает': x => x.age < 3 && x.btcPct2h > -0.1,
    'свежий + выше EMA + не падает': x => x.age < 3 && x.btcAbove && x.btcPct2h > -0.1,
  })) {
    const a = agg(withB.filter(fn));
    if (!a || a.n < 30) { console.log(`  ${name.padEnd(32)} мало данных (${a ? a.n : 0})`); continue; }
    const d = Math.round((a.exp - base.exp) * 1000) / 1000;
    console.log(`  ${name.padEnd(32)} ${String(a.n).padStart(5)}   ${String(a.win).padStart(3)}%   ${((a.exp >= 0 ? '+' : '') + a.exp + '%').padStart(9)}   ${((d >= 0 ? '+' : '') + d).padStart(7)}`);
  }

  // устойчивость лучшего по трём отрезкам
  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  console.log('\n  Устойчивость «свежий ≤10 мин» по трём отрезкам:');
  [['отр.1', x => x.t < c1], ['отр.2', x => x.t >= c1 && x.t < c2], ['отр.3', x => x.t >= c2]].forEach(([n, f]) => {
    const a = agg(S.filter(x => f(x) && x.age < 3)), b = agg(S.filter(f));
    if (!a || !b || a.n < 20) { console.log(`    ${n}: мало данных`); return; }
    console.log(`    ${n}: свежие ${a.exp >= 0 ? '+' : ''}${a.exp}% (n=${a.n}) против всех ${b.exp >= 0 ? '+' : ''}${b.exp}% → ${a.exp > b.exp ? '✅ лучше' : '❌ хуже'}`);
  });

  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-research.json'), JSON.stringify({ S, base, at: Date.now() }));
  console.log('\nСэмплы: scalp-research.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
