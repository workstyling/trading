/**
 * ДАЁТ ЛИ «НЕ У ДНА СУТОК» ЧТО-ТО СВЕРХ УЖЕ ВНЕДРЁННОГО.
 * ────────────────────────────────────────────────────────────────────────
 * pump.js мерил кандидатов от СТАРОГО гейта — без фильтров диапазона и
 * пампа, которые уже стоят в бою. Там «отсечь дно суток» выглядел плюсом,
 * но часть этого плюса могли давать те же сделки, что уже отсекают
 * внедрённые условия. Здесь база — ЖИВОЙ гейт целиком, и вопрос один:
 * добавляет ли фильтр что-то поверх него.
 *
 * Цель +2% (новая), аварийный стоп −6%, комиссия круга 0.25%.
 * Запуск: node src/scalp/daypos.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 7;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 2.0, SL = 6, FEE = 0.25;
const MAX_BARS = 288;
const CUTS = [0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
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
  for (let p = 0; p < Math.ceil(days * 24 * 12 / 300); p++) {
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

/** Исход сделки: что раньше — цель, стоп или сутки */
function simulate(c, i) {
  const entry = c[i].close;
  for (let j = i + 1; j <= Math.min(i + MAX_BARS, c.length - 1); j++) {
    if ((c[j].low / entry - 1) * 100 <= -SL) return { pnl: -SL - FEE, bars: j - i, win: false };
    if ((c[j].high / entry - 1) * 100 >= TP) return { pnl: TP - FEE, bars: j - i, win: true };
  }
  const last = Math.min(i + MAX_BARS, c.length - 1);
  const pnl = (c[last].close / entry - 1) * 100 - FEE;
  return { pnl, bars: last - i, win: pnl > 0 };
}

function stats(arr) {
  if (!arr.length) return null;
  const exp = arr.reduce((a, x) => a + x.pnl, 0) / arr.length;
  const win = arr.filter(x => x.win).length / arr.length * 100;
  const hours = arr.reduce((a, x) => a + x.bars, 0) / arr.length / 12;
  const gains = arr.filter(x => x.pnl > 0).reduce((a, x) => a + x.pnl, 0);
  const loss = -arr.filter(x => x.pnl < 0).reduce((a, x) => a + x.pnl, 0);
  return { n: arr.length, exp, win, hours, pf: loss > 0 ? gains / loss : Infinity };
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
  console.log(`${coins.length} монет, ${DAYS} дней · цель +${TP}% · стоп −${SL}% · комиссия ${FEE}%\n`);

  const btc = await fetch5m('BTC', DAYS);
  const btcCloses = btc.map(x => x.close);
  const btcE = emaSeries(btcCloses, 240);
  const btcOk = new Map();
  for (let i = 0; i < btc.length; i++) btcOk.set(btc[i].t, btcE[i] != null && btcCloses[i] > btcE[i]);

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
      const lo4 = Math.min(...w48.map(x => x.low)), hi4 = Math.max(...w48.map(x => x.high));
      const rangePos = hi4 > lo4 ? (px - lo4) / (hi4 - lo4) : 0.5;
      const range4Pct = lo4 > 0 ? (hi4 - lo4) / lo4 * 100 : 999;
      const runUp = closes[i - 288] > 0 ? (closes[i - 48] / closes[i - 288] - 1) * 100 : 0;
      const rWin = rsi.slice(i - 12, i + 1).filter(v => v != null);
      const rMin = rWin.length ? Math.min(...rWin) : null;
      // ЖИВОЙ гейт целиком — то, что реально стоит в бою
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && btcOk.get(c[i].t)
        && range4Pct < 8 && runUp <= 15;
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;
      const w288 = c.slice(i - 288, i + 1);
      const lo24 = Math.min(...w288.map(x => x.low)), hi24 = Math.max(...w288.map(x => x.high));
      const dayPos = hi24 > lo24 ? (px - lo24) / (hi24 - lo24) : 0.5;
      S.push({ coin: coins[ci], t: c[i].t, dayPos, ...simulate(c, i) });
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('•');
  }

  console.log(`\n\nВходов по ЖИВОМУ гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 60) { console.log('Мало входов для выводов.'); return; }

  const base = stats(S);
  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [x => x.t < c1, x => x.t >= c1 && x.t < c2, x => x.t >= c2];

  console.log('═'.repeat(94));
  console.log(`  БАЗА (живой гейт): n=${base.n} · win ${base.win.toFixed(0)}% · ожидание ${base.exp >= 0 ? '+' : ''}${base.exp.toFixed(3)}% · PF ${base.pf.toFixed(2)} · ${base.hours.toFixed(1)} ч`);
  console.log('═'.repeat(94));
  console.log('  ПОРОГ «НЕ НИЖЕ X% СУТОЧНОГО ДИАПАЗОНА»');
  console.log('  ' + '─'.repeat(90));
  console.log('  ОТСЕЧЬ    ОСТАНЕТСЯ   WIN%    ОЖИДАНИЕ   vs БАЗА     PF     отр.1    отр.2    отр.3   ИТОГ');
  const out = [];
  for (const cut of CUTS) {
    const kept = S.filter(x => x.dayPos >= cut);
    const st = stats(kept);
    if (!st || st.n < 40) { console.log(`  <${(cut * 100).toFixed(0)}%      мало входов (${kept.length})`); continue; }
    const vals = segs.map(f => {
      const sub = kept.filter(f);
      return sub.length >= 12 ? sub.reduce((a, x) => a + x.pnl, 0) / sub.length : null;
    });
    const baseVals = segs.map(f => {
      const sub = S.filter(f);
      return sub.length >= 12 ? sub.reduce((a, x) => a + x.pnl, 0) / sub.length : null;
    });
    // на каждом отрезке фильтр должен быть НЕ ХУЖЕ базы — иначе он ничего не добавляет
    const better = vals.filter((v, k) => v != null && baseVals[k] != null && v > baseVals[k]).length;
    const tested = vals.filter((v, k) => v != null && baseVals[k] != null).length;
    out.push({ cut, ...st, better, tested });
    console.log(`  <${((cut * 100).toFixed(0) + '%').padEnd(5)} ${(Math.round(st.n / base.n * 100) + '%').padStart(9)}  ` +
      `${(st.win.toFixed(0) + '%').padStart(6)}  ${((st.exp >= 0 ? '+' : '') + st.exp.toFixed(3) + '%').padStart(9)}  ` +
      `${((st.exp - base.exp >= 0 ? '+' : '') + (st.exp - base.exp).toFixed(3)).padStart(8)}  ${st.pf.toFixed(2).padStart(6)}  ` +
      vals.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8)).join(' ') +
      `   ${better}/${tested} ` + (better === tested && tested === 3 ? '✅' : better === 0 ? '❌' : '⚠️'));
  }
  console.log('\n  Отрезки сравниваются С БАЗОЙ на том же отрезке, а не с нулём:');
  console.log('  ' + segs.map((f, k) => {
    const sub = S.filter(f);
    return `база отр.${k + 1} ${sub.length ? (sub.reduce((a, x) => a + x.pnl, 0) / sub.length).toFixed(3) : 'н/д'}%`;
  }).join(' · '));

  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-daypos.json'),
    JSON.stringify({ base, out, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-daypos.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
