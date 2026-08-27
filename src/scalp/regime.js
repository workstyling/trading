/**
 * НАСКОЛЬКО ВЫСОКО ДОЛЖЕН БЫТЬ BTC НАД EMA20.
 * ────────────────────────────────────────────────────────────────────────
 * Гейт требует «BTC выше EMA20 (1ч)» как двоичное условие. Живые данные
 * показали перекос: медианный запас на входах всего 0.1%, у 19 из 36 он
 * меньше 0.2%. Это не случайность — условия входа (монета у дна диапазона,
 * RSI выходит из ямы) чаще всего выполняются сразу после того, как рынок
 * упал и BTC только-только вернулся к EMA20. Гейт систематически стреляет
 * в самой слабой точке собственного условия.
 *
 * Вопрос: даёт ли требование МИНИМАЛЬНОГО запаса что-то сверх текущего
 * гейта. База — живой гейт целиком, как в daypos.js: мерить кандидата от
 * старой версии уже приводило к ложной находке.
 *
 * Запуск: node src/scalp/regime.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 10;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 2.0, SL = 6, FEE = 0.25;
const MAX_BARS = 288;
const MARGINS = [0, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2];
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
    .map(c => ({ t: c[0], low: c[1], high: c[2], open: c[3], close: c[4] }))
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

  // BTC: запас над EMA20 в каждый момент (EMA на часовых, как в бою)
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
  const margins = bc.map((x, i) => ({ t: x.t, m: be[i] != null ? (x.close / be[i] - 1) * 100 : null }))
    .filter(x => x.m != null);
  const marginAt = (ts) => {
    const sec = Math.floor(ts / 3600) * 3600;
    for (let i = margins.length - 1; i >= 0; i--) if (margins[i].t <= sec) return margins[i].m;
    return null;
  };

  const S = [];
  for (let ci = 0; ci < coins.length; ci++) {
    const c = await fetch5m(coins[ci], DAYS);
    if (c.length < 600) { process.stdout.write('.'); continue; }
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
      // живой гейт целиком; запас BTC берём числом, чтобы резать по нему
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && bm != null
        && range4 < 8 && runUp <= 15;
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;
      S.push({ t: c[i].t, bm, ...simulate(c, i) });
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('.');
  }

  console.log(`\n\nВходов по живому гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 60) { console.log('Мало входов.'); return; }

  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [x => x.t < c1, x => x.t >= c1 && x.t < c2, x => x.t >= c2];

  console.log('='.repeat(92));
  console.log('  РАСПРЕДЕЛЕНИЕ ЗАПАСА BTC НА ВХОДАХ');
  console.log('='.repeat(92));
  const bs = S.filter(x => x.bm > 0).map(x => x.bm).sort((a, b) => a - b);
  const thin = bs.filter(x => x < 0.2).length;
  console.log(`  медиана ${bs[Math.floor(bs.length / 2)].toFixed(2)}%  ·  меньше 0.2%: ${thin}/${bs.length} (${Math.round(thin / bs.length * 100)}%)`);

  console.log('\n' + '='.repeat(92));
  console.log('  ЗАСЛУЖИВАЕТ ЛИ УСЛОВИЕ ПО РЕЖИМУ СВОЕГО МЕСТА');
  console.log('='.repeat(92));
  console.log('  Живые контрольные группы показали, что монеты, провалившие ТОЛЬКО');
  console.log('  условие по BTC, идут лучше прошедших. Проверяем на истории.\n');
  console.log('  ГРУППА                    N     WIN%   ОЖИДАНИЕ     PF      отр.1    отр.2    отр.3');
  const groups = [
    ['BTC выше EMA20 (в бою)', x => x.bm > 0],
    ['BTC ниже EMA20 (режется)', x => x.bm <= 0],
    ['без условия по режиму', () => true],
  ];
  for (const [name, f] of groups) {
    const a = S.filter(f);
    const st = stats(a);
    if (!st) { console.log('  ' + name.padEnd(26) + 'нет данных'); continue; }
    const vals = segs.map(g => { const b = a.filter(g); return b.length >= 12 ? stats(b).exp : null; });
    console.log('  ' + name.padEnd(24) + String(st.n).padStart(5) + '  ' +
      (st.win.toFixed(0) + '%').padStart(6) + '  ' +
      ((st.exp >= 0 ? '+' : '') + st.exp.toFixed(3) + '%').padStart(9) + '  ' +
      st.pf.toFixed(2).padStart(6) + '  ' +
      vals.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8)).join(' '));
  }

  console.log('\n' + '='.repeat(92));
  console.log('  ТРЕБОВАТЬ ЗАПАС НЕ МЕНЬШЕ X% (только там, где BTC выше EMA20)');
  console.log('='.repeat(92));
  console.log('  ПОРОГ   ОСТАНЕТСЯ   WIN%   ОЖИДАНИЕ   vs БАЗА     PF     отр.1    отр.2    отр.3   ИТОГ');
  const A = S.filter(x => x.bm > 0);
  const base = stats(A);
  const baseSeg = segs.map(f => { const a = A.filter(f); return a.length >= 12 ? stats(a).exp : null; });
  const out = [];
  for (const m of MARGINS) {
    const kept = A.filter(x => x.bm >= m);
    const st = stats(kept);
    if (!st || st.n < 40) { console.log(`  >=${m}%     мало входов (${kept.length})`); continue; }
    const vals = segs.map(f => { const a = kept.filter(f); return a.length >= 12 ? stats(a).exp : null; });
    const better = vals.filter((v, k) => v != null && baseSeg[k] != null && v > baseSeg[k]).length;
    const tested = vals.filter((v, k) => v != null && baseSeg[k] != null).length;
    out.push({ m, ...st, better, tested });
    console.log(`  >=${String(m + '%').padEnd(5)} ${(Math.round(st.n / base.n * 100) + '%').padStart(9)}  ` +
      `${(st.win.toFixed(0) + '%').padStart(5)}  ${((st.exp >= 0 ? '+' : '') + st.exp.toFixed(3) + '%').padStart(9)}  ` +
      `${((st.exp - base.exp >= 0 ? '+' : '') + (st.exp - base.exp).toFixed(3)).padStart(8)}  ${st.pf.toFixed(2).padStart(6)}  ` +
      vals.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8)).join(' ') +
      `   ${better}/${tested} ` + (better === tested && tested === 3 ? 'OK' : better === 0 ? 'NO' : '~'));
  }
  console.log('\n  База (любой запас > 0): ' +
    `n=${base.n} win ${base.win.toFixed(0)}% ожидание ${base.exp >= 0 ? '+' : ''}${base.exp.toFixed(3)}% PF ${base.pf.toFixed(2)}`);
  console.log('  По отрезкам: ' + baseSeg.map((v, k) => `отр.${k + 1} ${v == null ? 'н/д' : v.toFixed(3) + '%'}`).join(' · '));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-regime.json'), JSON.stringify({ base, out, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-regime.json');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
