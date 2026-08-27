/**
 * ПАМП НА ГОРИЗОНТЕ БОЛЬШЕ СУТОК.
 * ────────────────────────────────────────────────────────────────────────
 * Условие «не после пампа» смотрит ровно одно окно: от 24 часов назад до
 * 4 часов назад. На STX оно показало −0.6% и пропустило вход с баллом 90,
 * хотя монета за 7 дней выросла на 81%, а за 14 — на 113%. На суточном
 * горизонте там действительно тихо: за 24 часа −1.0%. Фильтр не ошибся,
 * он просто не смотрит туда, где произошёл рост.
 *
 * Это ровно тот дефект, с которого начинался разбор: «выросло, потом
 * падает, а система думает, что это откат». Проверяем, помогает ли
 * отсекать входы по МНОГОДНЕВНОМУ росту.
 *
 * База — живой гейт целиком. Дневной рост считаем по дневным свечам на
 * момент входа, без заглядывания вперёд.
 *
 * Запуск: node src/scalp/runup.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 25;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 2.0, SL = 6, FEE = 0.25;
const MAX_BARS = 288;
// пороги: отсекать вход, если рост за N дней превысил X%
const RULES = [
  ['3д > 20%', 3, 20], ['3д > 30%', 3, 30],
  ['7д > 25%', 7, 25], ['7д > 40%', 7, 40], ['7д > 60%', 7, 60],
  ['14д > 40%', 14, 40], ['14д > 70%', 14, 70],
];
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STABLE = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'GUSD', 'USDP', 'FRAX', 'LUSD', 'CRVUSD',
  'PYUSD', 'EURC', 'FDUSD', 'USDS', 'USDM', 'SUSD', 'DOLA', 'RAI', 'EUR', 'GBP', 'CBETH', 'PAXG', 'WBTC']);

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
    await sleep(110);
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
  const coins = uni.slice(0, 110).map(x => x.coin);
  console.log(`${coins.length} монет, ${DAYS} дней · цель +${TP}% · стоп -${SL}%\n`);

  // BTC над EMA20 (часовые) — условие живого гейта
  const btc1h = [];
  let end = Date.now();
  for (let p = 0; p < Math.ceil(DAYS * 24 / 300) + 1; p++) {
    const start = end - 300 * 3600 * 1000;
    const d = await fetchJson(`${CB}/products/BTC-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (Array.isArray(d) && d.length) btc1h.push(...d); else break;
    end = start; await sleep(150);
  }
  const bc = btc1h.filter(x => Array.isArray(x) && x[4] > 0).map(x => ({ t: x[0], close: x[4] })).sort((a, b) => a.t - b.t);
  const be = emaSeries(bc.map(x => x.close), 20);
  const bmArr = bc.map((x, i) => ({ t: x.t, m: be[i] != null ? (x.close / be[i] - 1) * 100 : null })).filter(x => x.m != null);
  const marginAt = (ts) => {
    const sec = Math.floor(ts / 3600) * 3600;
    for (let i = bmArr.length - 1; i >= 0; i--) if (bmArr[i].t <= sec) return bmArr[i].m;
    return null;
  };

  const S = [];
  for (let ci = 0; ci < coins.length; ci++) {
    const c = await fetch5m(coins[ci], DAYS);
    if (c.length < 600) { process.stdout.write('.'); continue; }
    // дневные свечи той же монеты — по ним многодневный рост, без заглядывания вперёд
    const dj = await fetchJson(`${CB}/products/${coins[ci]}-USD/candles?granularity=86400`);
    const daily = Array.isArray(dj)
      ? dj.filter(x => x[4] > 0).map(x => ({ t: x[0], close: x[4] })).sort((a, b) => a.t - b.t)
      : [];
    await sleep(120);
    const runUpDays = (ts, n) => {
      if (daily.length < n + 1) return null;
      const sec = Math.floor(ts / 86400) * 86400;
      let k = -1;
      for (let i = daily.length - 1; i >= 0; i--) if (daily[i].t <= sec) { k = i; break; }
      if (k < n) return null;
      const then = daily[k - n].close, now = daily[k].close;
      return then > 0 ? (now / then - 1) * 100 : null;
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
      const bm = marginAt(c[i].t);
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && bm != null && bm > 0
        && range4 < 8 && runUp <= 15;
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;
      S.push({
        t: c[i].t,
        u3: runUpDays(c[i].t, 3), u7: runUpDays(c[i].t, 7), u14: runUpDays(c[i].t, 14),
        ...simulate(c, i),
      });
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('.');
  }

  console.log(`\n\nВходов по живому гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 60) { console.log('Мало входов.'); return; }

  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [x => x.t < c1, x => x.t >= c1 && x.t < c2, x => x.t >= c2];
  const base = stats(S);
  const baseSeg = segs.map(f => { const a = S.filter(f); return a.length >= 12 ? stats(a).exp : null; });

  console.log('='.repeat(96));
  console.log('  МНОГОДНЕВНЫЙ РОСТ НА ВХОДАХ (чего фильтр не видит)');
  console.log('='.repeat(96));
  for (const [k, key] of [['3 дня', 'u3'], ['7 дней', 'u7'], ['14 дней', 'u14']]) {
    const v = S.map(x => x[key]).filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) { console.log('  ' + k.padEnd(9) + 'нет данных'); continue; }
    console.log('  ' + k.padEnd(9) + 'медиана ' + v[Math.floor(v.length / 2)].toFixed(1) + '%  ·  ' +
      'выше +30%: ' + v.filter(x => x > 30).length + '/' + v.length +
      '  ·  выше +60%: ' + v.filter(x => x > 60).length + '/' + v.length);
  }

  console.log('\n' + '='.repeat(96));
  console.log('  ОТСЕЧЬ ВХОДЫ ПОСЛЕ МНОГОДНЕВНОГО РОСТА');
  console.log('='.repeat(96));
  console.log('  ПРАВИЛО        ОСТАНЕТСЯ   WIN%   ОЖИДАНИЕ   vs БАЗА     PF     отр.1    отр.2    отр.3   ИТОГ');
  const out = [];
  for (const [name, days, lim] of RULES) {
    const key = days === 3 ? 'u3' : days === 7 ? 'u7' : 'u14';
    const kept = S.filter(x => x[key] == null || x[key] <= lim);
    const st = stats(kept);
    if (!st || st.n < 40) { console.log('  ' + name.padEnd(14) + ' мало входов (' + kept.length + ')'); continue; }
    const vals = segs.map(f => { const a = kept.filter(f); return a.length >= 12 ? stats(a).exp : null; });
    const better = vals.filter((v, k) => v != null && baseSeg[k] != null && v > baseSeg[k]).length;
    const tested = vals.filter((v, k) => v != null && baseSeg[k] != null).length;
    out.push({ name, days, lim, ...st, better, tested });
    console.log('  ' + name.padEnd(14) + (Math.round(st.n / base.n * 100) + '%').padStart(9) + '  ' +
      (st.win.toFixed(0) + '%').padStart(6) + '  ' +
      ((st.exp >= 0 ? '+' : '') + st.exp.toFixed(3) + '%').padStart(9) + '  ' +
      ((st.exp - base.exp >= 0 ? '+' : '') + (st.exp - base.exp).toFixed(3)).padStart(8) + '  ' +
      st.pf.toFixed(2).padStart(6) + '  ' +
      vals.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8)).join(' ') +
      '   ' + better + '/' + tested + ' ' + (better === tested && tested === 3 ? 'OK' : better === 0 ? 'NO' : '~'));
  }
  console.log('\n  База: n=' + base.n + ' win ' + base.win.toFixed(0) + '% ожидание ' +
    (base.exp >= 0 ? '+' : '') + base.exp.toFixed(3) + '% PF ' + base.pf.toFixed(2));
  console.log('  По отрезкам: ' + baseSeg.map((v, k) => 'отр.' + (k + 1) + ' ' + (v == null ? 'н/д' : v.toFixed(3) + '%')).join(' · '));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-runup.json'), JSON.stringify({ base, out, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-runup.json');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
