const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
const sfx = process.argv[3] || '';
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('нет ' + name);
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const ctx = { console, fmtPrice: v => Number(v).toFixed(6), fmtPxM: v => Number(v).toFixed(6) };
vm.createContext(ctx);
vm.runInContext(grab('_sparkSvg' + sfx), ctx);
// Полоса «где мы в диапазоне» — отдельная функция, её тоже надо занести:
// renderTrend рисует её внутри себя.
vm.runInContext(grab('_rangeBar' + sfx), ctx);
vm.runInContext(grab('_fixedRow' + sfx), ctx);
vm.runInContext(grab('renderTrend' + sfx), ctx);
const render = ctx['renderTrend' + sfx];

const t0 = Date.now();
const falling = Array.from({ length: 18 }, (_, i) => ({ t: t0 + i * 1000, p: 4.40 - i * 0.004, v: 4.41 - i * 0.004 }));
const rising = Array.from({ length: 18 }, (_, i) => ({ t: t0 + i * 1000, p: 4.30 + i * 0.004, v: 4.31 + i * 0.004 }));
const flat = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 1000, p: 4.36, v: 4.36 }));
const cases = [
  ['покупка, цена падает', falling, 'buy'],
  ['покупка, цена растёт', rising, 'buy'],
  ['покупка, стоит', flat, 'buy'],
  ['продажа, прибыль растёт', Array.from({ length: 18 }, (_, i) => ({ t: t0 + i * 1000, p: 4.3, v: 5 + i * 1.2 })), 'sell'],
  ['продажа через ноль', Array.from({ length: 18 }, (_, i) => ({ t: t0 + i * 1000, p: 4.3, v: 8 - i * 1.1 })), 'sell'],
  ['пусто', [], 'buy'],
];
let bad = 0;
for (const [name, hist, mode] of cases) {
  let out;
  try { out = render(hist, mode); } catch (e) { console.log('  ПАДЕНИЕ ' + name + ': ' + e.message); bad++; continue; }
  const nan = /NaN|Infinity|undefined/.test(out);
  if (nan) bad++;
  const green = out.includes('#30d158');
  const red = out.includes('#ff6b6b');
  const word = (out.match(/(дешевеет|дорожает|растёт|падает|стоит)/) || ['—'])[0];
  const ref = out.includes('stroke-dasharray');
  console.log('  ' + (nan ? 'ПЛОХО ' : 'ok    ') + name.padEnd(26) +
    'слово: ' + word.padEnd(10) + 'цвет: ' + (green ? 'зелёный' : red ? 'красный' : 'серый ').padEnd(8) +
    (ref ? 'опорная линия есть' : ''));
}
console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе случаи чистые');
