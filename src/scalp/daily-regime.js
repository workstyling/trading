/**
 * ЕСТЬ ЛИ ПЕРЕВЕС ХОТЬ В КАКОМ-ТО РЕЖИМЕ РЫНКА.
 * ────────────────────────────────────────────────────────────────────────
 * Четыре кандидата подряд — позиция в суточном диапазоне, порог запаса BTC,
 * многодневный памп — не пережили проверку по отрезкам, а само условие по
 * режиму не оправдало своего места. На 25 днях гейт даёт около −0.1% при
 * профит-факторе 0.9. Подбирать пятый фильтр к базе без перевеса значит
 * подгонять шум.
 *
 * Другой вопрос: существует ли перевес хотя бы в узком режиме. Гейт — это
 * лонг-онли возврат к среднему. Условие «BTC выше EMA20 (1ч)» должно было
 * отсекать падающий рынок и не отсекает: часовая EMA дёргается вместе с
 * рынком. Проверяем ДНЕВНОЙ масштаб, который так не дёргается:
 *   - BTC выше/ниже дневной EMA20
 *   - доходность BTC за 7 дней положительная/отрицательная
 *   - обе комбинации
 *
 * ВАЖНАЯ ОГОВОРКА, которую нельзя забыть при чтении: лонг-онли стратегия
 * ВСЕГДА выглядит лучше на растущем рынке. Само по себе это не находка.
 * Смысл имеет только то, держится ли перевес внутри группы по отрезкам и
 * хватает ли его на комиссию.
 *
 * Запуск: node src/scalp/daily-regime.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 60;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 2.0, SL = 6, FEE = 0.25;
const MAX_BARS = 288;
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
  const coins = uni.slice(0, 90).map(x => x.coin);
  console.log(`${coins.length} монет, ${DAYS} дней · цель +${TP}% · стоп -${SL}%\n`);

  // BTC: часовая EMA20 (условие живого гейта) + ДНЕВНОЙ режим
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
  const hourMargin = (ts) => {
    const sec = Math.floor(ts / 3600) * 3600;
    for (let i = bh.length - 1; i >= 0; i--) {
      if (bh[i].t <= sec) return bhe[i] != null ? (bh[i].c / bhe[i] - 1) * 100 : null;
    }
    return null;
  };

  const bdj = await fetchJson(`${CB}/products/BTC-USD/candles?granularity=86400`);
  const bd = (bdj || []).filter(x => x[4] > 0).map(x => ({ t: x[0], c: x[4] })).sort((a, b) => a.t - b.t);
  const bde = emaSeries(bd.map(x => x.c), 20);
  const dailyState = (ts) => {
    const sec = Math.floor(ts / 86400) * 86400;
    let k = -1;
    for (let i = bd.length - 1; i >= 0; i--) if (bd[i].t <= sec) { k = i; break; }
    if (k < 8 || bde[k] == null) return null;
    return {
      aboveDaily: bd[k].c > bde[k],
      ret7: (bd[k].c / bd[k - 7].c - 1) * 100,
    };
  };
  console.log(`Дневных свечей BTC: ${bd.length}, из них с EMA20: ${bde.filter(x => x != null).length}\n`);

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
      const hm = hourMargin(c[i].t);
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && hm != null && hm > 0
        && range4 < 8 && runUp <= 15;
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;
      const ds = dailyState(c[i].t);
      S.push({ t: c[i].t, aboveDaily: ds ? ds.aboveDaily : null, ret7: ds ? ds.ret7 : null, ...simulate(c, i) });
    }
    if (ci % 10 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('.');
  }

  console.log(`\n\nВходов по живому гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 100) { console.log('Мало входов.'); return; }

  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [x => x.t < c1, x => x.t >= c1 && x.t < c2, x => x.t >= c2];

  const show = (name, arr) => {
    const st = stats(arr);
    if (!st) { console.log('  ' + name.padEnd(34) + 'нет данных'); return null; }
    const vals = segs.map(f => { const a = arr.filter(f); return a.length >= 15 ? stats(a).exp : null; });
    const pos = vals.filter(v => v != null && v > 0).length;
    const tested = vals.filter(v => v != null).length;
    console.log('  ' + name.padEnd(34) + String(st.n).padStart(5) + '  ' +
      (st.win.toFixed(0) + '%').padStart(6) + '  ' +
      ((st.exp >= 0 ? '+' : '') + st.exp.toFixed(3) + '%').padStart(9) + '  ' +
      st.pf.toFixed(2).padStart(6) + '  ' +
      vals.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v.toFixed(3)).padStart(8)).join(' ') +
      '   ' + pos + '/' + tested + ' ' + (pos === tested && tested === 3 ? 'OK' : pos === 0 ? 'NO' : '~'));
    return st;
  };

  console.log('='.repeat(100));
  console.log('  ЕСТЬ ЛИ ПЕРЕВЕС В КАКОМ-ТО РЕЖИМЕ');
  console.log('='.repeat(100));
  console.log('  ГРУППА                                N    WIN%   ОЖИДАНИЕ     PF     отр.1    отр.2    отр.3  В ПЛЮС');
  show('всё подряд (текущий гейт)', S);
  console.log('  ' + '-'.repeat(96));
  show('BTC выше дневной EMA20', S.filter(x => x.aboveDaily === true));
  show('BTC ниже дневной EMA20', S.filter(x => x.aboveDaily === false));
  console.log('  ' + '-'.repeat(96));
  show('BTC за 7д в плюсе', S.filter(x => x.ret7 != null && x.ret7 > 0));
  show('BTC за 7д в минусе', S.filter(x => x.ret7 != null && x.ret7 <= 0));
  console.log('  ' + '-'.repeat(96));
  show('за 7д > +3%', S.filter(x => x.ret7 != null && x.ret7 > 3));
  show('выше дневной EMA20 И 7д > 0', S.filter(x => x.aboveDaily === true && x.ret7 != null && x.ret7 > 0));

  const up = stats(S.filter(x => x.aboveDaily === true));
  const dn = stats(S.filter(x => x.aboveDaily === false));
  console.log('\n  ОГОВОРКА: лонг-онли стратегия всегда выглядит лучше на растущем рынке.');
  console.log('  Само расхождение групп находкой не является. Смысл имеет только то,');
  console.log('  держится ли плюс ВНУТРИ группы на всех трёх отрезках и покрывает ли комиссию.');
  if (up && dn) {
    console.log(`\n  Разница между режимами: ${(up.exp - dn.exp).toFixed(3)} п.п. на сделку`);
    console.log(`  Доля времени в верхнем режиме: ${Math.round(up.n / (up.n + dn.n) * 100)}% входов`);
  }
  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-daily.json'), JSON.stringify({ n: S.length, up, dn, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-daily.json');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
