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
const R = ctx['renderTrend' + sfx], BAR = ctx['_rangeBar' + sfx];

console.log('  положение маркера:');
for (const [name, lo, hi, now] of [
  ['на минимуме', 0.7814, 0.7817, 0.7814],
  ['на максимуме', 0.7814, 0.7817, 0.7817],
  ['посередине', 0.7814, 0.7817, 0.78155],
  ['плоско (lo==hi)', 0.7814, 0.7814, 0.7814],
  ['вышло за край', 0.7814, 0.7817, 0.7900],
]) {
  const h = BAR(lo, hi, now, 'дешевле', 'дороже', v => '$' + v.toFixed(4));
  const m = h.match(/left:([\d.]+)%;top:-4px/);
  const bad = /NaN|undefined|Infinity/.test(h);
  console.log('    ' + name.padEnd(18) + (m ? m[1] + '%' : (h.includes('top:-4px') ? '?' : 'маркера нет (плоско)')) + (bad ? '  ПЛОХО: NaN' : ''));
}

const t0 = Date.now();
const mk = arr => arr.map((v, i) => ({ t: t0 + i * 1000, p: v, v }));
console.log('\n  режимы целиком:');
for (const [name, hist, mode] of [
  ['покупка, падает', mk([0.7817, 0.78165, 0.7816, 0.78150, 0.78143]), 'buy'],
  ['продажа, минус', mk([-24.78, -26.5, -28.1, -30.57]), 'sell'],
  ['пусто', [], 'buy'],
]) {
  let out;
  try { out = R(hist, mode); } catch (e) { console.log('    ПАДЕНИЕ ' + name + ': ' + e.message); continue; }
  const bad = /NaN|undefined|Infinity/.test(out);
  const hasBar = out.includes('top:-4px');
  const where = (out.match(/Сейчас [^<]*/) || ['—'])[0];
  console.log('    ' + name.padEnd(18) + (bad ? 'ПЛОХО NaN' : 'ok') + ' | полоса ' + (hasBar ? 'есть' : 'нет') + ' | ' + where);
}
