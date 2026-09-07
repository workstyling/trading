// Замер влияния разгона, зашитого в runupOdds() в server.js.
//
// Вопрос: портит ли предшествующий рост шанс дождаться возврата. Интуиция
// говорит «покупаешь после разгона — значит поздно», измерение говорит
// обратное. Скрипт это воспроизводит.
//
// Данные берутся из кеша, который наполняет тот же сбор, что и
// measure-recovery.js. Запуск:
//   node scripts/measure-runup.js [окно разгона в 5м свечах, по умолчанию 288 = сутки]
//
// Тот же вопрос на выборке в пять раз большей: важен ли предшествующий рост.
// Свечи 5-минутные, поэтому все окна считаются в них: 30 минут = 6 свечей,
// сутки = 288, трое суток = 864.
const fs = require('fs');
const path = require('path');
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
let cache;
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); }
catch { console.error('нет кеша ' + CACHE + ' — сначала соберите свечи'); process.exit(1); }
const band = (v, a, b, c, d) => v <= a || v >= d ? 0 : v < b ? (v - a) / (b - a) : v > c ? (d - v) / (d - c) : 1;
const rsi14 = c => { if (c.length < 15) return null; let u = 0, d = 0; for (let i = c.length - 14; i < c.length; i++) { const x = c[i] - c[i - 1]; if (x >= 0) u += x; else d -= x; } return d === 0 ? 100 : 100 - 100 / (1 + (u / 14) / (d / 14)); };

const NEED = 0.30;
const H1 = 12, H6 = 72, H24 = 288;       // час, шесть часов, сутки в 5м свечах
const WINDOW = 864;                       // трое суток
const BACK = Number(process.argv[2] || 288);   // окно разгона в 5м свечах

const rows = [];
for (const coin in cache) {
  const cs = cache[coin];
  if (cs.length < BACK + WINDOW + 300) continue;
  for (let i = BACK; i < cs.length - WINDOW; i += 3) {
    const px = cs[i].cl; if (!(px > 0)) continue;
    const hi30 = Math.max(...cs.slice(i - 6, i + 1).map(c => c.hi));
    const pull = hi30 > 0 ? (hi30 - px) / hi30 * 100 : null;
    if (pull == null) continue;
    const rsi = rsi14(cs.slice(i - 14, i + 1).map(c => c.cl));
    if (rsi == null) continue;
    const score = 100 * band(pull, 0.15, 0.40, 0.80, 1.50) * band(rsi, 20, 28, 45, 58);
    if (score < 40) continue;

    const back = cs.slice(i - BACK, i + 1);
    const loBack = Math.min(...back.map(c => c.lo));
    const runup = loBack > 0 ? (px / loBack - 1) * 100 : null;
    const hiDay = Math.max(...cs.slice(i - H24, i + 1).map(c => c.hi));
    const fall = hiDay > 0 ? (hiDay - px) / hiDay * 100 : null;

    const tp = px * (1 + NEED / 100);
    let bars = null, worst = 0;
    for (let k = i + 1; k <= i + WINDOW; k++) {
      const d = (cs[k].lo / px - 1) * 100; if (d < worst) worst = d;
      if (cs[k].hi >= tp) { bars = k - i; break; }
    }
    rows.push({ coin, runup, fall, bars, worst });
  }
}

const pct = (a, f) => a.length ? a.filter(f).length / a.length * 100 : 0;
const q = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] : 0;
const st = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); return { m, se: sd / Math.sqrt(a.length) }; };

console.log('монет ' + Object.keys(cache).length + ', точек в списке (балл 40+): ' + rows.length + '\n');
console.log('  разгон за ' + (BACK/288).toFixed(0) + ' сут       n     за час   за 6ч   за сут   НЕ вернулось   просадка 10%');
const G = [['менее 5%', 0, 5], ['5–10%', 5, 10], ['10–20%', 10, 20], ['20–35%', 20, 35], ['более 35%', 35, 1e9]];
const store = {};
for (const [label, lo, hi] of G) {
  const g = rows.filter(r => r.runup != null && r.runup >= lo && r.runup < hi);
  if (g.length < 100) { console.log('  ' + label.padEnd(20) + String(g.length).padStart(6) + '   мало'); continue; }
  store[label] = g;
  console.log('  ' + label.padEnd(20) + String(g.length).padStart(6) + '   ' +
    pct(g, r => r.bars != null && r.bars <= H1).toFixed(0).padStart(5) + '%  ' +
    pct(g, r => r.bars != null && r.bars <= H6).toFixed(0).padStart(5) + '%  ' +
    pct(g, r => r.bars != null && r.bars <= H24).toFixed(0).padStart(6) + '%   ' +
    pct(g, r => r.bars == null).toFixed(1).padStart(10) + '%   ' +
    q(g.map(r => r.worst), 0.10).toFixed(2) + '%');
}

// значимо ли отличается «сильно вырос» от «не вырос»
const lowKey = 'менее 5%';
const hiKeys = ['20–35%', 'более 35%'];
if (store[lowKey]) {
  for (const k of hiKeys) {
    if (!store[k]) continue;
    const a = store[lowKey].map(r => r.bars != null && r.bars <= H1 ? 1 : 0);
    const b = store[k].map(r => r.bars != null && r.bars <= H1 ? 1 : 0);
    const A = st(a), B = st(b);
    const d = (B.m - A.m) * 100, se = Math.sqrt(A.se ** 2 + B.se ** 2) * 100;
    console.log('\n  «' + k + '» против «' + lowKey + '» по возврату за час: ' +
      (d >= 0 ? '+' : '') + d.toFixed(1) + ' п.п. ±' + se.toFixed(1) +
      '  ' + (Math.abs(d) > 2 * se ? 'ОТЛИЧИМО' : 'не отличимо от нуля'));
    const wa = st(store[lowKey].map(r => r.worst)), wb = st(store[k].map(r => r.worst));
    const dw = wb.m - wa.m, sew = Math.sqrt(wa.se ** 2 + wb.se ** 2);
    console.log('    средняя просадка по пути: ' + wb.m.toFixed(2) + '% против ' + wa.m.toFixed(2) +
      '%, разница ' + (dw >= 0 ? '+' : '') + dw.toFixed(2) + '% ±' + sew.toFixed(2) +
      '  ' + (Math.abs(dw) > 2 * sew ? 'ОТЛИЧИМО' : 'не отличимо'));
  }
}
