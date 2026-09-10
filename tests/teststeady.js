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
const mk = arr => arr.map((v, i) => ({ t: t0 + i * 1000, p: 1, v }));

// Ровно тот случай со скриншота: два реальных шага вниз, остальные тики стоят
const stair = mk([-24.78, -24.78, -24.78, -26.5, -26.5, -26.5, -26.5, -30.57, -30.57]);
const cases = [
  ['лесенка: 2 движения, 6 стоят', stair],
  ['ровное падение', mk([5, 4, 3, 2, 1, 0, -1, -2, -3])],
  ['рваное', mk([5, 6, 4, 7, 3, 8, 2, 9, 1])],
  ['совсем плоско', mk([7, 7, 7, 7, 7, 7])],
  ['одно движение', mk([7, 7, 7, 7, 7, 6])],
];
let bad = 0;
for (const [name, hist] of cases) {
  let out;
  try { out = R(hist, 'sell'); } catch (e) { console.log('  ПАДЕНИЕ ' + name + ': ' + e.message); bad++; continue; }
  if (/NaN|undefined|Infinity/.test(out)) { bad++; }
  const m = out.match(/(ровно|рвано|почти стоит|разнонаправленно)[^<]*/);
  console.log('  ' + name.padEnd(30) + (m ? m[0] : '(ничего)'));
}
console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе случаи чистые');
// Без этого запускатор считает набор зелёным: он смотрит на код выхода,
// а не на печать. Три провала так и ехали мимо ворот выкатки.
process.exit(bad ? 1 : 0);
