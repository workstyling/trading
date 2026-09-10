// Сколько монета уже висит в списке — и меняет ли это исход.
//
// Панель предупреждает про «висит долго» с порога 90 минут, а форвардный
// журнал вообще считает только первое пересечение (первые четыре минуты).
// Оба числа взяты из соображений, а не из замера. Раз отметка «можно брать»
// будет на них опираться, надо померить.
//
// Возраст серии: сколько времени подряд монета уже находится ниже своего
// суточного максимума на 3%+ к моменту входа.
const fs = require('fs'), path = require('path');
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
const NEED = 0.30, GATE = 3, DAY = 288;
const fallPct = (h, p) => (h - p) / h * 100;

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const rows = [];
let coins = 0;
for (const coin in cache) {
  const cs = cache[coin];
  if (!cs || cs.length < DAY * 2 + 20) continue;
  coins++;
  // Заранее считаем падение в каждой точке, чтобы возраст серии брался быстро
  const fall = new Array(cs.length).fill(null);
  for (let i = DAY; i < cs.length; i++) {
    const t0 = cs[i].t;
    const wd = cs.slice(Math.max(0, i - DAY * 3), i + 1).filter(c => t0 - c.t <= 24 * 3600);
    if (wd.length < 30) continue;
    const hd = Math.max(...wd.map(c => c.hi));
    if (hd > 0) fall[i] = fallPct(hd, cs[i].cl);
  }
  for (let i = DAY; i < cs.length - 13; i += 3) {
    if (fall[i] == null || fall[i] < GATE) continue;
    const px = cs[i].cl;
    if (!(px > 0)) continue;
    // Возраст серии: сколько минут подряд до этой точки падение держалось 3%+
    let k = i - 1, age = 0;
    while (k >= DAY && fall[k] != null && fall[k] >= GATE) { age = (cs[i].t - cs[k].t) / 60; k--; }
    const t0 = cs[i].t;
    const w30 = cs.slice(Math.max(0, i - 40), i + 1).filter(c => t0 - c.t <= 30 * 60);
    if (w30.length < 2) continue;
    const hi30 = Math.max(...w30.map(c => c.hi));
    const pull = hi30 > 0 ? fallPct(hi30, px) : null;
    const tp = px * (1 + NEED / 100);
    let hit = false, worst = 0, last = null;
    for (let m = i + 1; m < cs.length; m++) {
      const mins = (cs[m].t - t0) / 60;
      if (mins + 5 > 60) break;
      const d = (cs[m].lo / px - 1) * 100; if (d < worst) worst = d;
      if (!hit && cs[m].hi >= tp) hit = true;
      last = cs[m].cl;
    }
    if (last == null || pull == null) continue;
    rows.push({ coin, age, pull, hit, m60: (last / px - 1) * 100, mae: worst });
  }
}

const stat = (list) => {
  if (list.length < 200) return null;
  const n = list.length;
  const avg = f => list.reduce((s, x) => s + f(x), 0) / n;
  const share = f => list.filter(f).length / n * 100;
  const per = {};
  for (const r of list) (per[r.coin] = per[r.coin] || []).push(r);
  const parts = Object.values(per).filter(a => a.length >= 30).map(a => a.reduce((s, x) => s + x.m60, 0) / a.length);
  let se = null;
  if (parts.length >= 8) {
    const m = parts.reduce((s, x) => s + x, 0) / parts.length;
    const sd = Math.sqrt(parts.reduce((s, x) => s + (x - m) ** 2, 0) / (parts.length - 1));
    se = sd / Math.sqrt(parts.length);
  }
  return { n, hit: share(r => r.hit), m60: avg(r => r.m60), se, mae: avg(r => r.mae), bad3: share(r => r.mae <= -3) };
};
const show = (label, list) => {
  const s = stat(list);
  if (!s) { console.log('  ' + label.padEnd(22) + 'мало (' + list.length + ')'); return; }
  console.log('  ' + label.padEnd(22) + String(s.n).padStart(7) + s.hit.toFixed(0).padStart(8) + '%' +
    s.m60.toFixed(3).padStart(9) + '%' + (s.se ? ' ±' + s.se.toFixed(2) : '      ') +
    s.mae.toFixed(2).padStart(9) + '%' + s.bad3.toFixed(1).padStart(8) + '%');
};

console.log('\nмонет ' + coins + ', точек входа ' + rows.length);
console.log('\n  сколько уже висит        n   дошли    через час        просадка  ниже −3%');
show('меньше 30 мин', rows.filter(r => r.age < 30));
show('30-90 мин', rows.filter(r => r.age >= 30 && r.age < 90));
show('1.5-6 ч', rows.filter(r => r.age >= 90 && r.age < 360));
show('6-24 ч', rows.filter(r => r.age >= 360 && r.age < 1440));
show('больше суток', rows.filter(r => r.age >= 1440));

console.log('\nТо же, но только с откатом от 1.5%:');
const d = rows.filter(r => r.pull >= 1.5);
console.log('  сколько уже висит        n   дошли    через час        просадка  ниже −3%');
show('меньше 30 мин', d.filter(r => r.age < 30));
show('30-90 мин', d.filter(r => r.age >= 30 && r.age < 90));
show('1.5-6 ч', d.filter(r => r.age >= 90 && r.age < 360));
show('6-24 ч', d.filter(r => r.age >= 360 && r.age < 1440));
show('больше суток', d.filter(r => r.age >= 1440));
