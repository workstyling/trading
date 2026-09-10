const fs = require('fs'), vm = require('vm');
const [, , file, sfx = ''] = process.argv;
const src = fs.readFileSync(file, 'utf8');
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('нет ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const ctx = { console, fmtPrice: v => Number(v).toFixed(6) };
vm.createContext(ctx);
vm.runInContext(grab('_sparkSvg' + sfx), ctx);
// Полоса «где мы в диапазоне» — отдельная функция, её тоже надо занести:
// renderTrend рисует её внутри себя.
vm.runInContext(grab('_rangeBar' + sfx), ctx);
vm.runInContext(grab('_fixedRow' + sfx), ctx);
vm.runInContext(grab('renderTrend' + sfx), ctx);
const R = ctx['renderTrend' + sfx];

const t0 = Date.now();
const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 1000, p: 1, v: f(i) }));
const cases = [
  ['продажа: всё окно в минусе', mk(8, i => -14.17 - i * 0.17), 'sell'],
  ['продажа: пересекает ноль',   mk(12, i => 6 - i * 1.1), 'sell'],
  ['продажа: всё в плюсе',       mk(10, i => 20 + i * 0.4), 'sell'],
  ['продажа: ровное падение',    mk(10, i => 5 - i), 'sell'],
  ['продажа: рваное',            mk(10, i => 5 + (i % 2 ? 1.2 : -1.5)), 'sell'],
  ['покупка: дешевеет',          mk(10, i => 0.67 - i * 0.0004), 'buy'],
  ['покупка: плоско',            mk(10, () => 0.665), 'buy'],
  ['две точки',                  mk(2, i => -3 + i), 'sell'],
];
let bad = 0;
for (const [name, hist, mode] of cases) {
  let out;
  try { out = R(hist, mode); } catch (e) { console.log('  ПАДЕНИЕ ' + name + ': ' + e.message); bad++; continue; }
  const nan = /NaN|Infinity|undefined/.test(out);
  if (nan) bad++;
  const ref = out.includes('stroke-dasharray');
  const outside = out.includes('уровень вне окна');
  const st = (out.match(/(ровно|рвано) \d+ из \d+ шагов (вниз|вверх)/) || ['—'])[0];
  console.log('  ' + (nan ? 'ПЛОХО ' : 'ok    ') + name.padEnd(28) +
    (ref ? (outside ? 'опора вне окна ' : 'опора внутри   ') : 'опоры нет      ') +
    '| ' + st);
}
console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе случаи чистые');
// Без этого запускатор считает набор зелёным: он смотрит на код выхода,
// а не на печать. Три провала так и ехали мимо ворот выкатки.
process.exit(bad ? 1 : 0);
