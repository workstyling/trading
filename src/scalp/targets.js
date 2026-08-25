/**
 * КАКУЮ ЦЕЛЬ СТАВИТЬ.
 * ────────────────────────────────────────────────────────────────────────
 * Цель +1.38% взята из настройки Sell Markup, а не измерена. Компромисс тут
 * очевиден только на словах: низкая цель берётся чаще, но комиссия съедает
 * бóльшую её долю; высокая даёт больше на сделку, но реже достигается и
 * дольше держит позицию под риском разворота.
 *
 * Считаем ожидание на сделку и ожидание НА ЧАС удержания для набора целей
 * при текущем аварийном стопе. Второе важнее: капитал освобождается и может
 * работать снова.
 *
 * Запуск: node src/scalp/targets.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 7;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const SL = 6, FEE = 0.25;
const MAX_BARS = 288;            // сутки в 5m-барах
const TARGETS = [0.6, 0.8, 1.0, 1.38, 1.8, 2.5, 3.5, 5.0];
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

/** Один проход по будущему: для каждой цели фиксируем исход и время */
function simulateAll(c, i) {
  const entry = c[i].close;
  const res = {};
  const pending = new Set(TARGETS);
  let stopBar = null;
  for (let j = i + 1; j <= Math.min(i + MAX_BARS, c.length - 1) && pending.size; j++) {
    const up = (c[j].high / entry - 1) * 100;
    const dn = (c[j].low / entry - 1) * 100;
    if (stopBar === null && dn <= -SL) stopBar = j - i;
    for (const t of [...pending]) {
      // стоп сработал раньше цели — фиксируем убыток
      if (stopBar !== null) { res[t] = { pnl: -SL - FEE, bars: stopBar, hit: false }; pending.delete(t); continue; }
      if (up >= t) { res[t] = { pnl: t - FEE, bars: j - i, hit: true }; pending.delete(t); }
    }
  }
  // не дошли за сутки — закрываем по рынку
  const last = Math.min(i + MAX_BARS, c.length - 1);
  const mkt = (c[last].close / entry - 1) * 100;
  for (const t of pending) res[t] = { pnl: mkt - FEE, bars: last - i, hit: false };
  return res;
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
  console.log(`${coins.length} монет, ${DAYS} дней · аварийный стоп −${SL}% · комиссия круга ${FEE}%\n`);

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
      const lo = Math.min(...w48.map(x => x.low)), hi = Math.max(...w48.map(x => x.high));
      const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;
      const range4Pct = lo > 0 ? (hi - lo) / lo * 100 : 999;
      const runUp = closes[i - 288] > 0 ? (closes[i - 48] / closes[i - 288] - 1) * 100 : 0;
      const rWin = rsi.slice(i - 12, i + 1).filter(v => v != null);
      const rMin = rWin.length ? Math.min(...rWin) : null;
      // текущий гейт целиком, включая новые условия
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && btcOk.get(c[i].t)
        && range4Pct < 8 && runUp <= 15;
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;
      S.push({ coin: coins[ci], t: c[i].t, res: simulateAll(c, i) });
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('•');
  }

  console.log(`\n\nВходов по текущему гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 60) { console.log('Мало входов для выводов.'); return; }

  console.log('═'.repeat(96));
  console.log('  КАКУЮ ЦЕЛЬ СТАВИТЬ');
  console.log('═'.repeat(96));
  console.log('  ЦЕЛЬ    ДОШЛИ   ЧИСТЫМИ   ОЖИДАНИЕ   СРЕДНЕЕ ВРЕМЯ   НА ЧАС    КОМИССИЯ СЪЕДАЕТ');
  console.log('  ' + '─'.repeat(92));
  const rows = [];
  for (const t of TARGETS) {
    const arr = S.map(s => s.res[t]);
    const hit = arr.filter(x => x.hit).length;
    const exp = arr.reduce((a, x) => a + x.pnl, 0) / arr.length;
    const hours = arr.reduce((a, x) => a + x.bars, 0) / arr.length / 12;
    const perHour = hours > 0 ? exp / hours : 0;
    const feeShare = Math.round(FEE / t * 100);
    rows.push({ t, hitPct: Math.round(hit / arr.length * 100), exp, hours, perHour, feeShare });
    console.log(`  +${String(t).padEnd(5)} ${(Math.round(hit / arr.length * 100) + '%').padStart(6)}   ` +
      `${('+' + (t - FEE).toFixed(2) + '%').padStart(7)}   ${((exp >= 0 ? '+' : '') + exp.toFixed(3) + '%').padStart(9)}   ` +
      `${(hours.toFixed(1) + ' ч').padStart(11)}   ${((perHour >= 0 ? '+' : '') + perHour.toFixed(3) + '%').padStart(8)}   ${(feeShare + '%').padStart(10)}`);
  }
  const bestExp = rows.slice().sort((a, b) => b.exp - a.exp)[0];
  const bestHour = rows.slice().sort((a, b) => b.perHour - a.perHour)[0];
  console.log('');
  console.log(`  Лучшая по ожиданию на сделку: +${bestExp.t}%  (${bestExp.exp >= 0 ? '+' : ''}${bestExp.exp.toFixed(3)}%)`);
  console.log(`  Лучшая по ожиданию в час:     +${bestHour.t}%  (${bestHour.perHour >= 0 ? '+' : ''}${bestHour.perHour.toFixed(3)}%/ч, среднее удержание ${bestHour.hours.toFixed(1)} ч)`);

  // устойчивость по трём отрезкам
  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [['отр.1', x => x.t < c1], ['отр.2', x => x.t >= c1 && x.t < c2], ['отр.3', x => x.t >= c2]];
  console.log('\n' + '═'.repeat(96));
  console.log('  УСТОЙЧИВОСТЬ (ожидание на сделку по отрезкам)');
  console.log('═'.repeat(96));
  console.log('  ЦЕЛЬ      отр.1      отр.2      отр.3    в плюс');
  console.log('  ' + '─'.repeat(60));
  for (const t of TARGETS) {
    const vals = segs.map(([, f]) => {
      const sub = S.filter(f);
      return sub.length >= 15 ? sub.reduce((a, s) => a + s.res[t].pnl, 0) / sub.length : null;
    });
    const good = vals.filter(v => v != null && v > 0).length;
    const tested = vals.filter(v => v != null).length;
    console.log(`  +${String(t).padEnd(6)} ` + vals.map(v => (v == null ? '   н/д' : (v >= 0 ? '+' : '') + v.toFixed(3) + '%').padStart(10)).join(' ') +
      `   ${good}/${tested} ` + (good === tested && tested === 3 ? '✅' : good === 0 ? '❌' : '⚠️'));
  }

  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-targets.json'), JSON.stringify({ rows, n: S.length, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-targets.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
