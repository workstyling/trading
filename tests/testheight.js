// Высота блока не должна зависеть от состояния рынка: считаем строки и
// проверяем, что их число одинаково во всех случаях.
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
for (const n of ['_fixedRow' + sfx, '_rangeBar' + sfx, '_sparkSvg' + sfx, 'renderTrend' + sfx]) vm.runInContext(grab(n), ctx);
const R = ctx['renderTrend' + sfx];

const t0 = Date.now();
const mk = arr => arr.map((v, i) => ({ t: t0 + i * 1000, p: v, v }));
const cases = [
  ['ровное падение', mk([5, 4, 3, 2, 1, 0, -1, -2, -3]), 'sell'],
  ['лесенка со стоянками', mk([-24.78, -24.78, -24.78, -26.5, -26.5, -26.5, -30.57, -30.57]), 'sell'],
  ['разнонаправленно', mk([5, 6, 4, 7, 3, 8, 2, 9, 1]), 'sell'],
  ['совсем плоско', mk([7, 7, 7, 7, 7, 7]), 'sell'],
  ['всё в плюсе (опора вне окна)', mk([20, 21, 22, 23, 24]), 'sell'],
  ['пересекает ноль', mk([6, 4, 2, 0.5, -1, -3]), 'sell'],
  ['покупка падает', mk([0.7817, 0.78165, 0.7816, 0.78150, 0.78143]), 'buy'],
  ['покупка плоско', mk([0.665, 0.665, 0.665, 0.665]), 'buy'],
];
let bad = 0;
const sizes = new Set();
for (const [name, hist, mode] of cases) {
  const out = R(hist, mode);
  // считаем блочные строки фиксированной высоты и наличие полосы
  const rows = (out.match(/height:1[56]px;line-height/g) || []).length;
  const bar = out.includes('top:-4px') || out.includes('margin-top:5px');
  const minH = (out.match(/min-height:(\d+)px/) || [])[1];
  const nan = /NaN|undefined|Infinity/.test(out);
  if (nan) bad++;
  sizes.add(rows + '|' + (bar ? 1 : 0) + '|' + minH);
  console.log('  ' + name.padEnd(30) + 'строк ' + rows + ' | полоса ' + (bar ? 'есть' : 'нет ') + ' | min-height ' + minH + 'px' + (nan ? '  NaN!' : ''));
}
console.log('\n  различных раскладок: ' + sizes.size + (sizes.size === 1 ? '  (высота постоянна)' : '  РАЗЛИЧАЮТСЯ: ' + [...sizes].join(', ')));
if (sizes.size !== 1) bad++;
console.log(bad ? 'ПРОБЛЕМ: ' + bad : 'ok');
// Без этого запускатор считает набор зелёным: он смотрит на код выхода,
// а не на печать. Три провала так и ехали мимо ворот выкатки.
process.exit(bad ? 1 : 0);
