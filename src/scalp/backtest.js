/**
 * БЭКТЕСТ КРАТКОСРОЧНОГО СИГНАЛА (горизонт 20-60 минут).
 *
 * Тот же метод, что для reversal: сначала измеряем, потом назначаем веса.
 * Свечи 5m, проход вперёд, в каждом баре видно только прошлое.
 *
 * Барьер: что раньше за 1 час — цель +1.38% (Sell Markup) или стоп −1.5%.
 * Дополнительно меряем доходность через 20/40/60 минут.
 *
 * Запуск: node src/scalp/backtest.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 7;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 1.38, SL = 1.5;
const BARS = { '20m': 4, '40m': 8, '60m': 12, '3h': 36, '6h': 72 };
// Меряем барьер сразу на трёх горизонтах: час, три часа, шесть часов
const HORIZONS = { h1: 12, h3: 36, h6: 72 };
const BARRIER_BARS = 72;
const MIN_GAP_BARS = 6;       // 30 мин между сигналами одной монеты
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STABLE = new Set(['USDT','USDC','DAI','BUSD','TUSD','GUSD','USDP','FRAX','LUSD','CRVUSD',
  'PYUSD','EURC','FDUSD','USDS','USDM','SUSD','DOLA','RAI','EUR','GBP','CBETH','PAXG','WBTC']);

// ── индикаторы ──
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

function forward(c, i) {
  const entry = c[i].close, out = {};
  for (const [k, n] of Object.entries(BARS)) {
    const j = i + n;
    out[k] = j < c.length ? (c[j].close / entry - 1) * 100 : null;
  }
  let mfe = 0, mae = 0, hitAt = null, stopAt = null;
  for (let j = i + 1; j <= Math.min(i + BARRIER_BARS, c.length - 1); j++) {
    const up = c[j].high / entry - 1, dn = c[j].low / entry - 1;
    if (up > mfe) mfe = up;
    if (dn < mae) mae = dn;
    if (stopAt === null && dn <= -SL / 100) stopAt = j - i;
    if (hitAt === null && up >= TP / 100) hitAt = j - i;
    if (stopAt !== null || hitAt !== null) { if (stopAt !== null && hitAt !== null) break; }
  }
  // Для каждого горизонта: 1 = цель раньше стопа, 0 = стоп раньше, null = не разрешилось
  for (const [k, n] of Object.entries(HORIZONS)) {
    const h = hitAt != null && hitAt <= n ? hitAt : null;
    const s = stopAt != null && stopAt <= n ? stopAt : null;
    out['b_' + k] = (h == null && s == null) ? null : (s == null ? 1 : h == null ? 0 : (s <= h ? 0 : 1));
  }
  out.barrier = out.b_h1;
  out.mfe = mfe * 100; out.mae = mae * 100;
  return out;
}

function bar(rows) {
  const res = rows.filter(r => r.fwd.barrier != null);
  const w = res.filter(r => r.fwd.barrier === 1).length, l = res.length - w;
  return {
    n: rows.length, resolved: res.length,
    win: res.length ? Math.round(w / res.length * 100) : null,
    pf: l ? Math.round((w * TP) / (l * SL) * 100) / 100 : null,
  };
}
const avg = (rows, k) => {
  const v = rows.map(r => r.fwd[k]).filter(x => x != null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 1000) / 1000 : null;
};

(async () => {
  const t0 = Date.now();
  console.log('Собираю вселенную...');
  const products = await fetchJson(`${CB}/products`);
  const pairs = (products || []).filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map(p => p.base_currency).filter(s => !STABLE.has(s));
  const universe = [];
  for (let i = 0; i < pairs.length; i += 25) {
    const batch = pairs.slice(i, i + 25);
    const st = await Promise.all(batch.map(async c => {
      const s = await fetchJson(`${CB}/products/${c}-USD/stats`, 1);
      if (!s) return null;
      const vol = (parseFloat(s.volume) || 0) * (parseFloat(s.last) || 0);
      return vol >= MIN_VOL ? { coin: c, vol } : null;
    }));
    universe.push(...st.filter(Boolean));
    await sleep(150);
  }
  universe.sort((a, b) => b.vol - a.vol);
  const coins = universe.slice(0, 110).map(x => x.coin);
  console.log(`Вселенная: ${coins.length} монет (объём ≥ $${(MIN_VOL / 1e3).toFixed(0)}K), ${DAYS} дней 5m-свечей\n`);

  const S = [];
  let ok = 0;
  for (let ci = 0; ci < coins.length; ci++) {
    const coin = coins[ci];
    const c = await fetch5m(coin, DAYS);
    if (c.length < 600) { process.stdout.write('.'); continue; }
    ok++;
    const closes = c.map(x => x.close);
    const rsi = rsiSeries(closes, 14);
    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
    let last = -999;
    for (let i = 60; i < c.length - BARRIER_BARS; i++) {
      if (i - last < MIN_GAP_BARS) continue;
      const px = closes[i];
      const vols = c.slice(i - 48, i).map(x => x.vol);
      const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
      const volX = avgVol > 0 ? c[i].vol / avgVol : 0;
      const drop30 = (px / closes[i - 6] - 1) * 100;      // 30 мин
      const drop2h = (px / closes[i - 24] - 1) * 100;     // 2 часа
      const win48 = c.slice(i - 48, i + 1);               // 4 часа
      const lo = Math.min(...win48.map(x => x.low)), hi = Math.max(...win48.map(x => x.high));
      const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;
      const r = rsi[i], rPrev = rsi[i - 1];
      const rMin12 = Math.min(...rsi.slice(i - 12, i + 1).filter(v => v != null));
      let green = 0;
      for (let k = i; k > i - 3 && closes[k] > c[k].open; k--) green++;
      const prev = c[i - 1];
      const engulf = c[i].close > c[i].open && prev.close < prev.open && c[i].close >= prev.open && c[i].open <= prev.close;
      const body = Math.abs(c[i].close - c[i].open), rng = c[i].high - c[i].low;
      const lowerWick = rng > 0 ? (Math.min(c[i].open, c[i].close) - c[i].low) / rng : 0;

      last = i;
      S.push({
        coin, t: c[i].t,
        rsi: r, rsiUp: r != null && rPrev != null && r > rPrev,
        rsiRecover: rMin12 < 30 && r != null && r > rMin12 + 3,
        aboveE9: e9[i] != null && px > e9[i],
        aboveE21: e21[i] != null && px > e21[i],
        e9overE21: e9[i] != null && e21[i] != null && e9[i] > e21[i],
        drop30, drop2h, rangePos, volX,
        green, engulf, lowerWick,
        fwd: forward(c, i),
      });
    }
    if (ci % 10 === 0) process.stdout.write(`\n[${ci}/${coins.length}] ${coin} n=${S.length} `); else process.stdout.write('•');
  }

  console.log(`\n\nМонет: ${ok} · сэмплов: ${S.length} · время ${Math.round((Date.now() - t0) / 1000)}с\n`);
  const BASE = bar(S);
  const BE = Math.round(SL / (TP + SL) * 100);
  const FEE = 0.25; // круг лимитками
  console.log('═'.repeat(94));
  console.log(`  БАЗА: случайный вход. Цель +${TP}% / стоп −${SL}%.  (n=${S.length})`);
  console.log(`  безубыток по win-rate: ${BE}% (без комиссий), ${Math.round((SL + FEE) / (TP - FEE + SL + FEE) * 100)}% (с комиссиями ${FEE}%)`);
  for (const k of Object.keys(BARS)) console.log(`  средний ход за ${k}: ${avg(S, k)}%  (комиссия круга ${FEE}%)`);
  console.log('');
  // Экономика по горизонтам: зависшие закрываем по рынку в конце окна
  const HMAP = { h1: '60m', h3: '3h', h6: '6h' };
  console.log('  ГОРИЗОНТ   РАЗРЕШИЛОСЬ   WIN%    ОЖИДАНИЕ НА СДЕЛКУ (зависшие — по рынку, с комиссией)');
  console.log('  ' + '─'.repeat(88));
  for (const [k, mk] of Object.entries(HMAP)) {
    const res = S.filter(s => s.fwd['b_' + k] != null);
    const w = res.filter(s => s.fwd['b_' + k] === 1).length;
    const hung = S.filter(s => s.fwd['b_' + k] == null);
    const hungAvg = hung.length ? hung.reduce((a, s) => a + (s.fwd[mk] ?? 0), 0) / hung.length : 0;
    const exp = (res.length / S.length) * ((w / res.length) * TP - (1 - w / res.length) * SL) + (hung.length / S.length) * hungAvg - FEE;
    console.log(`  ${k.padEnd(10)} ${(Math.round(res.length / S.length * 100) + '%').padStart(10)}   ${(Math.round(w / res.length * 100) + '%').padStart(4)}    ${(exp >= 0 ? '+' : '') + exp.toFixed(3)}%   ${exp > 0 ? '✅ плюс' : '❌ минус'}`);
  }
  console.log('═'.repeat(94));

  const SIG = {
    'RSI < 30': s => s.rsi != null && s.rsi < 30,
    'RSI < 25': s => s.rsi != null && s.rsi < 25,
    'RSI вышел из ямы (<30 → +3)': s => s.rsiRecover,
    'RSI растёт': s => s.rsiUp,
    'Цена выше EMA9 (5m)': s => s.aboveE9,
    'Цена выше EMA21 (5m)': s => s.aboveE21,
    'EMA9 > EMA21': s => s.e9overE21,
    'Провал ≥1.5% за 30мин': s => s.drop30 <= -1.5,
    'Провал ≥3% за 2ч': s => s.drop2h <= -3,
    'У дна 4ч (rangePos<0.2)': s => s.rangePos < 0.2,
    'У дна + отскок начался': s => s.rangePos < 0.25 && s.rsiUp,
    'Объём ≥2x': s => s.volX >= 2,
    'Объём ≥3x': s => s.volX >= 3,
    'Объём ≥2x + зелёная': s => s.volX >= 2 && s.green >= 1,
    'Длинная нижняя тень': s => s.lowerWick >= 0.5,
    'Бычье поглощение': s => s.engulf,
    '2+ зелёных подряд': s => s.green >= 2,
    'Провал + RSI из ямы': s => s.drop30 <= -1.5 && s.rsiRecover,
    'Провал + выше EMA9': s => s.drop30 <= -1.5 && s.aboveE9,
    'У дна + объём 2x': s => s.rangePos < 0.25 && s.volX >= 2,
    'У дна + RSI из ямы': s => s.rangePos < 0.25 && s.rsiRecover,
    'У дна + тень + объём': s => s.rangePos < 0.25 && s.lowerWick >= 0.4 && s.volX >= 1.5,
  };

  // разбиение по времени для проверки устойчивости
  const ts = S.map(s => s.t).sort((a, b) => a - b);
  const mid = ts[Math.floor(ts.length / 2)];
  const H1 = S.filter(s => s.t < mid), H2 = S.filter(s => s.t >= mid);
  const b1 = bar(H1), b2 = bar(H2);

  console.log('\n  СИГНАЛ                          N      WIN%   LIFT     PF     20м     60м    ПОЛ1  ПОЛ2  ИТОГ');
  console.log('  ' + '─'.repeat(90));
  const rows = [];
  for (const [name, fn] of Object.entries(SIG)) {
    const sub = S.filter(fn), b = bar(sub);
    if (b.resolved < 60) { console.log(`  ${name.padEnd(30)} ${String(b.n).padStart(5)}   — мало (${b.resolved})`); continue; }
    const lift = b.win - BASE.win;
    const p1 = bar(H1.filter(fn)), p2 = bar(H2.filter(fn));
    const l1 = p1.resolved >= 30 ? p1.win - b1.win : null;
    const l2 = p2.resolved >= 30 ? p2.win - b2.win : null;
    const stable = l1 != null && l2 != null && l1 > 0 && l2 > 0 ? '✅' : (l1 != null && l2 != null && l1 < 0 && l2 < 0 ? '❌' : '⚠️');
    rows.push({ name, n: b.n, win: b.win, lift, pf: b.pf, l1, l2, stable });
    const sg = v => v == null ? ' —' : (v >= 0 ? '+' : '') + v;
    console.log(`  ${name.padEnd(30)} ${String(b.n).padStart(5)}   ${String(b.win).padStart(3)}%  ${((lift >= 0 ? '+' : '') + lift + 'пп').padStart(6)}  ${String(b.pf).padStart(5)}  ${String(avg(sub, '20m')).padStart(6)}  ${String(avg(sub, '60m')).padStart(6)}  ${sg(l1).padStart(4)}  ${sg(l2).padStart(4)}  ${stable}`);
  }

  console.log('\n  Устойчивые (плюс в обеих половинах), по силе:');
  rows.filter(r => r.stable === '✅').sort((a, b) => b.lift - a.lift)
    .forEach(r => console.log(`    +${r.lift}пп  ${r.name}  (n=${r.n}, win ${r.win}%, PF ${r.pf})`));
  if (!rows.some(r => r.stable === '✅')) console.log('    нет ни одного');

  // Лучшие сигналы на горизонте 3 и 6 часов — там цель успевает отработать
  console.log('\n' + '═'.repeat(94));
  console.log('  ТЕ ЖЕ СИГНАЛЫ НА ГОРИЗОНТЕ 3ч и 6ч (ожидание на сделку с комиссиями)');
  console.log('═'.repeat(94));
  console.log('  СИГНАЛ                              N     3ч: win / ожид.        6ч: win / ожид.');
  console.log('  ' + '─'.repeat(88));
  const econ = (sub, k, mk) => {
    const res = sub.filter(s => s.fwd['b_' + k] != null);
    if (res.length < 50) return null;
    const w = res.filter(s => s.fwd['b_' + k] === 1).length;
    const hung = sub.filter(s => s.fwd['b_' + k] == null);
    const hungAvg = hung.length ? hung.reduce((a, s) => a + (s.fwd[mk] ?? 0), 0) / hung.length : 0;
    const exp = (res.length / sub.length) * ((w / res.length) * TP - (1 - w / res.length) * SL) + (hung.length / sub.length) * hungAvg - FEE;
    return { win: Math.round(w / res.length * 100), exp };
  };
  const ranked = [];
  for (const [name, fn] of Object.entries(SIG)) {
    const sub = S.filter(fn);
    if (sub.length < 300) continue;
    const e3 = econ(sub, 'h3', '3h'), e6 = econ(sub, 'h6', '6h');
    if (!e3 || !e6) continue;
    ranked.push({ name, n: sub.length, e3, e6 });
    const f = e => `${e.win}% / ${(e.exp >= 0 ? '+' : '') + e.exp.toFixed(3)}%`;
    console.log(`  ${name.padEnd(34)} ${String(sub.length).padStart(5)}   ${f(e3).padStart(18)}   ${f(e6).padStart(18)}`);
  }
  console.log('\n  Топ по ожиданию на 6ч:');
  ranked.sort((a, b) => b.e6.exp - a.e6.exp).slice(0, 6)
    .forEach(r => console.log(`    ${(r.e6.exp >= 0 ? '+' : '') + r.e6.exp.toFixed(3)}%  ${r.name}  (n=${r.n}, win ${r.e6.win}%)`));

  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-backtest.json'),
    JSON.stringify({ samples: S, base: BASE, cfg: { DAYS, TP, SL, MIN_VOL } }));
  console.log('\nСэмплы: scalp-backtest.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
