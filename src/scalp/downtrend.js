/**
 * ВХОД ПРОТИВ МНОГОДНЕВНОГО ПАДЕНИЯ.
 * ────────────────────────────────────────────────────────────────────────
 * POL: вырос 10 дней назад, с тех пор падает — за 3 дня −8.6%, за сутки
 * −6%, и он на 17% ниже двухнедельной вершины. При этом гейт даёт ему 7 из
 * 8: монета у дна 4-часового диапазона, RSI выходит из ямы, «не после
 * пампа» показывает −3%, потому что смотрит только сутки.
 *
 * Раньше я проверял обратное — вход ПОСЛЕ многодневного роста — и он
 * оказался редким и бесполезным для отсечения. Падение это другой случай и
 * куда более частый: гейт по устройству покупает провалы, а в затяжном
 * снижении провал не откупается, он продолжается.
 *
 * Проверяем два правила:
 *   - отсечь, если монета упала больше X% за N дней;
 *   - отсечь, если она глубже X% под своей вершиной за 14 дней.
 *
 * База — живой гейт целиком, включая недельное условие по BTC.
 * Запуск: node src/scalp/downtrend.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 30;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 2.0, SL = 6, FEE = 0.25;
const MAX_BARS = 288;
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STABLE = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'GUSD', 'USDP', 'FRAX', 'LUSD', 'CRVUSD',
  'PYUSD', 'EURC', 'FDUSD', 'USDS', 'USDM', 'SUSD', 'DOLA', 'RAI', 'EUR', 'GBP', 'CBETH', 'PAXG', 'WBTC']);

// правила: [подпись, вид, порог]
const RULES = [
  ['падение 3д > 5%', 'd3', -5], ['падение 3д > 10%', 'd3', -10],
  ['падение 7д > 8%', 'd7', -8], ['падение 7д > 15%', 'd7', -15],
  ['ниже вершины 14д на 10%', 'fromHi', -10],
  ['ниже вершины 14д на 15%', 'fromHi', -15],
  ['ниже вершины 14д на 25%', 'fromHi', -25],
];

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
  for (let p = 0; p < Math.ceil(days * 24 * 12 / 300); p++) {
    const start = end - 300 * 300 * 1000;
    const d = await fetchJson(`${CB}/products/${coin}-USD/candles?granularity=300&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (Array.isArray(d) && d.length) out.push(...d); else break;
    end = start;
    await sleep(105);
  }
  return out.filter(c => Array.isArray(c) && c[4] > 0)
    .map(c => ({ t: c[0], low: c[1], high: c[2], close: c[4] }))
    .sort((a, b) => a.t - b.t);
}
function simulate(c, i) {
  const entry = c[i].close;
  for (let j = i + 1; j <= Math.min(i + MAX_BARS, c.length - 1); j++) {
    if ((c[j].low / entry - 1) * 100 <= -SL) return { pnl: -SL - FEE, win: false };
    if ((c[j].high / entry - 1) * 100 >= TP) return { pnl: TP - FEE, win: true };
  }
  const last = Math.min(i + MAX_BARS, c.length - 1);
  const pnl = (c[last].close / entry - 1) * 100 - FEE;
  return { pnl, win: pnl > 0 };
}
function stats(a) {
  if (!a.length) return null;
  const exp = a.reduce((x, y) => x + y.pnl, 0) / a.length;
  const gains = a.filter(x => x.pnl > 0).reduce((s, x) => s + x.pnl, 0);
  const loss = -a.filter(x => x.pnl < 0).reduce((s, x) => s + x.pnl, 0);
  return { n: a.length, exp, win: a.filter(x => x.win).length / a.length * 100, pf: loss > 0 ? gains / loss : Infinity };
}

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
  const coins = uni.slice(0, 100).map(x => x.coin);
  console.log(`${coins.length} монет, ${DAYS} дней · цель +${TP}% · стоп -${SL}%\n`);

  // BTC: часовая EMA20 и недельная доходность — оба условия живого гейта
  const btc1h = [];
  let end = Date.now();
  for (let p = 0; p < Math.ceil(DAYS * 24 / 300) + 1; p++) {
    const start = end - 300 * 3600 * 1000;
    const d = await fetchJson(`${CB}/products/BTC-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (Array.isArray(d) && d.length) btc1h.push(...d); else break;
    end = start; await sleep(150);
  }
  const bh = btc1h.filter(x => Array.isArray(x) && x[4] > 0).map(x => ({ t: x[0], c: x[4] })).sort((a, b) => a.t - b.t);
  const bhe = emaSeries(bh.map(x => x.c), 20);
  const hourOk = (ts) => {
    const sec = Math.floor(ts / 3600) * 3600;
    for (let i = bh.length - 1; i >= 0; i--) if (bh[i].t <= sec) return bhe[i] != null && bh[i].c > bhe[i];
    return false;
  };
  const bdj = await fetchJson(`${CB}/products/BTC-USD/candles?granularity=86400`);
  const bd = (bdj || []).filter(x => x[4] > 0).map(x => ({ t: x[0], c: x[4] })).sort((a, b) => a.t - b.t);
  const weekOk = (ts) => {
    const sec = Math.floor(ts / 86400) * 86400;
    let k = -1;
    for (let i = bd.length - 1; i >= 0; i--) if (bd[i].t <= sec) { k = i; break; }
    return k >= 7 && bd[k - 7].c > 0 && (bd[k].c / bd[k - 7].c - 1) > 0;
  };

  const S = [];
  for (let ci = 0; ci < coins.length; ci++) {
    const c = await fetch5m(coins[ci], DAYS);
    if (c.length < 600) { process.stdout.write('.'); continue; }
    const dj = await fetchJson(`${CB}/products/${coins[ci]}-USD/candles?granularity=86400`);
    const daily = Array.isArray(dj)
      ? dj.filter(x => x[4] > 0).map(x => ({ t: x[0], c: x[4], h: x[2] })).sort((a, b) => a.t - b.t) : [];
    await sleep(110);
    const idxAt = (ts) => {
      const sec = Math.floor(ts / 86400) * 86400;
      for (let i = daily.length - 1; i >= 0; i--) if (daily[i].t <= sec) return i;
      return -1;
    };
    const retDays = (ts, n) => {
      const k = idxAt(ts);
      if (k < n || !daily[k - n] || !(daily[k - n].c > 0)) return null;
      return (daily[k].c / daily[k - n].c - 1) * 100;
    };
    const fromHigh = (ts, n) => {
      const k = idxAt(ts);
      if (k < n) return null;
      const hi = Math.max(...daily.slice(k - n, k + 1).map(x => x.h));
      return hi > 0 ? (daily[k].c / hi - 1) * 100 : null;
    };

    const closes = c.map(x => x.close);
    const rsi = rsiSeries(closes, 14);
    const e9 = emaSeries(closes, 9);
    let last = -999;
    for (let i = 288; i < c.length - MAX_BARS; i++) {
      const px = closes[i];
      const w48 = c.slice(i - 48, i + 1);
      const lo = Math.min(...w48.map(x => x.low)), hi = Math.max(...w48.map(x => x.high));
      const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;
      const range4 = lo > 0 ? (hi - lo) / lo * 100 : 999;
      const runUp = closes[i - 288] > 0 ? (closes[i - 48] / closes[i - 288] - 1) * 100 : 0;
      const rWin = rsi.slice(i - 12, i + 1).filter(v => v != null);
      const rMin = rWin.length ? Math.min(...rWin) : null;
      const ts = c[i].t;
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && range4 < 8 && runUp <= 15
        && hourOk(ts) && weekOk(ts);
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;
      S.push({
        t: ts,
        d3: retDays(ts, 3), d7: retDays(ts, 7), fromHi: fromHigh(ts, 14),
        ...simulate(c, i),
      });
    }
    if (ci % 10 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('.');
  }

  console.log(`\n\nВходов по живому гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 80) { console.log('Мало входов.'); return; }

  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [x => x.t < c1, x => x.t >= c1 && x.t < c2, x => x.t >= c2];
  const base = stats(S);
  const baseSeg = segs.map(f => { const a = S.filter(f); return a.length >= 15 ? stats(a).exp : null; });

  console.log('='.repeat(100));
  console.log('  В КАКОМ СОСТОЯНИИ МОНЕТА НА ВХОДЕ');
  console.log('='.repeat(100));
  for (const [label, key] of [['за 3 дня', 'd3'], ['за 7 дней', 'd7'], ['от вершины 14д', 'fromHi']]) {
    const v = S.map(x => x[key]).filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) continue;
    console.log('  ' + label.padEnd(16) + 'медиана ' + v[Math.floor(v.length / 2)].toFixed(1) + '%' +
      '  ·  ниже −10%: ' + v.filter(x => x < -10).length + '/' + v.length +
      '  ·  ниже −20%: ' + v.filter(x => x < -20).length + '/' + v.length);
  }

  console.log('\n' + '='.repeat(100));
  console.log('  ОТСЕЧЬ ВХОДЫ ПРОТИВ МНОГОДНЕВНОГО ПАДЕНИЯ');
  console.log('='.repeat(100));
  console.log('  ПРАВИЛО                    ОСТАНЕТСЯ  WIN%  ОЖИДАНИЕ  vs БАЗА    PF     отр.1    отр.2    отр.3  ИТОГ');
  const out = [];
  for (const [name, key, lim] of RULES) {
    const kept = S.filter(x => x[key] == null || x[key] >= lim);
    const st = stats(kept);
    if (!st || st.n < 50) { console.log('  ' + name.padEnd(26) + ' мало входов (' + kept.length + ')'); continue; }
    const vals = segs.map(f => { const a = kept.filter(f); return a.length >= 15 ? stats(a).exp : null; });
    const better = vals.filter((v, k) => v != null && baseSeg[k] != null && v > baseSeg[k]).length;
    const tested = vals.filter((v, k) => v != null && baseSeg[k] != null).length;
    out.push({ name, ...st, better, tested });
    console.log('  ' + name.padEnd(26) + (Math.round(st.n / base.n * 100) + '%').padStart(8) + '  ' +
      (st.win.toFixed(0) + '%').padStart(5) + '  ' +
      ((st.exp >= 0 ? '+' : '') + st.exp.toFixed(3) + '%').padStart(8) + '  ' +
      ((st.exp - base.exp >= 0 ? '+' : '') + (st.exp - base.exp).toFixed(3)).padStart(7) + '  ' +
      st.pf.toFixed(2).padStart(5) + '  ' +
      vals.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8)).join(' ') +
      '  ' + better + '/' + tested + ' ' + (better === tested && tested === 3 ? 'OK' : better === 0 ? 'NO' : '~'));
  }
  console.log('\n  База: n=' + base.n + ' win ' + base.win.toFixed(0) + '% ожидание ' +
    (base.exp >= 0 ? '+' : '') + base.exp.toFixed(3) + '% PF ' + base.pf.toFixed(2));
  console.log('  По отрезкам: ' + baseSeg.map((v, k) => 'отр.' + (k + 1) + ' ' + (v == null ? 'н/д' : v.toFixed(3) + '%')).join(' · '));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-downtrend.json'), JSON.stringify({ base, out, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-downtrend.json');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
