/**
 * ПРОВЕРКА ГИПОТЕЗЫ: «дно диапазона» после памПа — это не откат, а обвал.
 * ────────────────────────────────────────────────────────────────────────
 * Гейт входит, когда цена в нижних 25% четырёхчасового диапазона. Но если
 * монета только что резко выросла, этот диапазон растянут самим ростом:
 * падение с вершины на треть роста формально попадает в «нижние 25%», хотя
 * на деле это начало сдува, а не откат в тренде.
 *
 * Меряем признаки, отличающие один случай от другого, и смотрим, какие из
 * них реально разделяют исходы.
 *
 * Запуск: node src/scalp/pump.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 7;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 1.38, SL = 6, FEE = 0.25;
const HORIZON = 72;              // 6 часов в 5m-барах
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

function outcome(c, i) {
  const entry = c[i].close;
  for (let j = i + 1; j <= Math.min(i + HORIZON, c.length - 1); j++) {
    if (c[j].low / entry - 1 <= -SL / 100) return { pnl: -SL - FEE, why: 'SL' };
    if (c[j].high / entry - 1 >= TP / 100) return { pnl: TP - FEE, why: 'TP' };
  }
  const last = Math.min(i + HORIZON, c.length - 1);
  return { pnl: (c[last].close / entry - 1) * 100 - FEE, why: 'TIME' };
}

const agg = rows => {
  if (!rows.length) return null;
  const wins = rows.filter(r => r.pnl > 0).length;
  return {
    n: rows.length,
    win: Math.round(wins / rows.length * 100),
    exp: Math.round(rows.reduce((a, r) => a + r.pnl, 0) / rows.length * 1000) / 1000,
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
  console.log(`${coins.length} монет, ${DAYS} дней · цель +${TP}% / аварийный стоп −${SL}%\n`);

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
    for (let i = 288; i < c.length - HORIZON; i++) {     // нужен день истории позади
      const px = closes[i];
      const w48 = c.slice(i - 48, i + 1);                 // 4 часа
      const lo4 = Math.min(...w48.map(x => x.low)), hi4 = Math.max(...w48.map(x => x.high));
      const rangePos = hi4 > lo4 ? (px - lo4) / (hi4 - lo4) : 0.5;
      const rWin = rsi.slice(i - 12, i + 1).filter(v => v != null);
      const rMin = rWin.length ? Math.min(...rWin) : null;
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && btcOk.get(c[i].t);
      if (!gate) continue;
      if (i - last < 6) continue;
      last = i;

      // ── признаки «был памп» ──
      const w288 = c.slice(i - 288, i + 1);               // сутки
      const lo24 = Math.min(...w288.map(x => x.low)), hi24 = Math.max(...w288.map(x => x.high));
      const range4Pct = lo4 > 0 ? (hi4 - lo4) / lo4 * 100 : 0;      // ширина 4ч диапазона
      const range24Pct = lo24 > 0 ? (hi24 - lo24) / lo24 * 100 : 0;
      const posIn24 = hi24 > lo24 ? (px - lo24) / (hi24 - lo24) : 0.5;
      const fromHi4 = hi4 > 0 ? (hi4 - px) / hi4 * 100 : 0;          // просадка от 4ч вершины
      const fromHi24 = hi24 > 0 ? (hi24 - px) / hi24 * 100 : 0;
      // рост ДО текущего окна: закрытие 4ч назад против закрытия сутки назад
      const runUp = closes[i - 288] > 0 ? (closes[i - 48] / closes[i - 288] - 1) * 100 : 0;
      // где стояла 4ч вершина — свежая ли она
      let hiIdx = i - 48;
      for (let k = i - 48; k <= i; k++) if (c[k].high >= hi4) hiIdx = k;
      const barsSinceHi = i - hiIdx;

      S.push({
        coin: coins[ci], t: c[i].t, i,
        rangePos, range4Pct, range24Pct, posIn24, fromHi4, fromHi24, runUp, barsSinceHi,
        ...outcome(c, i),
      });
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] n=${S.length} `); else process.stdout.write('•');
  }

  console.log(`\n\nВходов по гейту: ${S.length} · ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (S.length < 80) { console.log('Мало входов.'); return; }
  const base = agg(S);
  console.log('═'.repeat(92));
  console.log(`  БАЗА (текущий гейт): n=${base.n} · win ${base.win}% · ожидание ${base.exp >= 0 ? '+' : ''}${base.exp}%`);
  console.log('═'.repeat(92));

  const DIMS = {
    'Ширина 4ч диапазона': [
      ['узкий (<3%)', s => s.range4Pct < 3],
      ['обычный (3–6%)', s => s.range4Pct >= 3 && s.range4Pct < 6],
      ['широкий (6–12%)', s => s.range4Pct >= 6 && s.range4Pct < 12],
      ['растянут пампом (12%+)', s => s.range4Pct >= 12],
    ],
    'Рост за сутки ДО окна': [
      ['падал (<−3%)', s => s.runUp < -3],
      ['стоял (−3…+3%)', s => s.runUp >= -3 && s.runUp <= 3],
      ['рос (+3…+15%)', s => s.runUp > 3 && s.runUp <= 15],
      ['памп (+15%+)', s => s.runUp > 15],
    ],
    'Просадка от 4ч вершины': [
      ['мелкая (<2%)', s => s.fromHi4 < 2],
      ['средняя (2–5%)', s => s.fromHi4 >= 2 && s.fromHi4 < 5],
      ['глубокая (5–10%)', s => s.fromHi4 >= 5 && s.fromHi4 < 10],
      ['обвал (10%+)', s => s.fromHi4 >= 10],
    ],
    'Позиция в СУТОЧНОМ диапазоне': [
      ['у дна суток (<20%)', s => s.posIn24 < 0.2],
      ['низ (20–40%)', s => s.posIn24 >= 0.2 && s.posIn24 < 0.4],
      ['середина (40–70%)', s => s.posIn24 >= 0.4 && s.posIn24 < 0.7],
      ['верх суток (70%+)', s => s.posIn24 >= 0.7],
    ],
    'Свежесть 4ч вершины': [
      ['вершина только что (<1ч)', s => s.barsSinceHi < 12],
      ['1–2 часа назад', s => s.barsSinceHi >= 12 && s.barsSinceHi < 24],
      ['больше 2ч назад', s => s.barsSinceHi >= 24],
    ],
  };

  for (const [dim, buckets] of Object.entries(DIMS)) {
    console.log(`\n  ${dim}`);
    console.log('  ' + '─'.repeat(74));
    console.log('  ГРУППА                            N     WIN%    ОЖИДАНИЕ    vs БАЗА');
    for (const [name, fn] of buckets) {
      const a = agg(S.filter(fn));
      if (!a || a.n < 15) { console.log(`  ${name.padEnd(32)} ${String(a ? a.n : 0).padStart(4)}   мало`); continue; }
      const d = Math.round((a.exp - base.exp) * 1000) / 1000;
      console.log(`  ${name.padEnd(32)} ${String(a.n).padStart(4)}   ${String(a.win).padStart(3)}%   ${((a.exp >= 0 ? '+' : '') + a.exp + '%').padStart(9)}   ${((d >= 0 ? '+' : '') + d).padStart(8)}`);
    }
  }

  // Проверка кандидатов-фильтров на устойчивость
  const ts = S.map(x => x.t).sort((a, b) => a - b);
  const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
  const segs = [['отр.1', x => x.t < c1], ['отр.2', x => x.t >= c1 && x.t < c2], ['отр.3', x => x.t >= c2]];

  const CANDIDATES = {
    'отсечь растянутый диапазон (>12%)': s => s.range4Pct < 12,
    'отсечь диапазон >8%': s => s.range4Pct < 8,
    'отсечь памп перед входом (>15%)': s => s.runUp <= 15,
    'отсечь рост перед входом (>3%)': s => s.runUp <= 3,
    'только у дна СУТОК (<40%)': s => s.posIn24 < 0.4,
    'вершина не свежее 1ч': s => s.barsSinceHi >= 12,
    'диапазон<8% + низ суток<40%': s => s.range4Pct < 8 && s.posIn24 < 0.4,
    'диапазон<12% + вершина>1ч': s => s.range4Pct < 12 && s.barsSinceHi >= 12,
  };
  console.log('\n' + '═'.repeat(92));
  console.log('  КАНДИДАТЫ В ДОПОЛНИТЕЛЬНЫЕ УСЛОВИЯ');
  console.log('═'.repeat(92));
  console.log('  ФИЛЬТР                                  ОСТАНЕТСЯ  WIN%   ОЖИДАНИЕ   отр.1    отр.2    отр.3   ИТОГ');
  console.log('  ' + '─'.repeat(88));
  for (const [name, fn] of Object.entries(CANDIDATES)) {
    const sub = S.filter(fn);
    const a = agg(sub);
    if (!a || a.n < 40) { console.log(`  ${name.padEnd(38)} мало данных (${a ? a.n : 0})`); continue; }
    const keep = Math.round(a.n / S.length * 100);
    const per = segs.map(([, f]) => {
      const x = agg(sub.filter(f)), y = agg(S.filter(f));
      return (x && y && x.n >= 10) ? Math.round((x.exp - y.exp) * 1000) / 1000 : null;
    });
    const good = per.filter(v => v != null && v > 0).length;
    const tested = per.filter(v => v != null).length;
    console.log(`  ${name.padEnd(38)} ${(keep + '%').padStart(7)}  ${String(a.win).padStart(3)}%  ${((a.exp >= 0 ? '+' : '') + a.exp + '%').padStart(9)}  ` +
      per.map(v => (v == null ? '  н/д' : (v >= 0 ? '+' : '') + v).padStart(7)).join(' ') +
      `   ${good}/${tested} ` + (good === tested && tested === 3 ? '✅' : good === 0 ? '❌' : '⚠️'));
  }

  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-pump.json'), JSON.stringify({ S, base, at: Date.now() }));
  console.log('\nСэмплы: scalp-pump.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
