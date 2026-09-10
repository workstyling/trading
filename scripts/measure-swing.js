// Падающий нож: опасно ли покупать монету, которая сперва взлетела, а теперь
// откатывается.
//
// Панель зовёт покупать по падению от СУТОЧНОГО МАКСИМУМА. Но максимум бывает
// разного происхождения. Монета, выросшая за сутки на 30% и сдавшая 5% с пика,
// формально даёт тот же сигнал, что монета, весь день сползавшая вниз, — а это
// совершенно разные вещи: в первом случае мы покупаем откат после разгона.
//
// Считаем то же, что журнал: вход по цене закрытия, цель +0.30% в течение
// часа, средний исход часа и худшая просадка по пути. Разбиваем по тому,
// сколько монета набрала ЗА СУТКИ к моменту входа.
const fs = require('fs'), path = require('path');
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
const NEED = 0.30, DEEP = 1.5, GATE_FALL = 3;
const DAY = 288, HOUR = 12;
const fallPct = (high, price) => (high - price) / high * 100;

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const rows = [];
let coins = 0;
for (const coin in cache) {
  const cs = cache[coin];
  if (!cs || cs.length < DAY * 2 + HOUR + 50) continue;
  coins++;
  for (let i = DAY; i < cs.length - HOUR - 1; i += 3) {
    const px = cs[i].cl;
    if (!(px > 0)) continue;
    const t0 = cs[i].t;
    const w30 = cs.slice(Math.max(0, i - 40), i + 1).filter(c => t0 - c.t <= 30 * 60);
    const wDay = cs.slice(Math.max(0, i - DAY * 3), i + 1).filter(c => t0 - c.t <= 24 * 3600);
    if (w30.length < 2 || wDay.length < 30) continue;
    const hi30 = Math.max(...w30.map(c => c.hi));
    const hiDay = Math.max(...wDay.map(c => c.hi));
    if (!(hi30 > 0) || !(hiDay > 0)) continue;
    const fall = fallPct(hiDay, px);
    if (fall < GATE_FALL) continue;                    // вход панели

    // Цена сутки назад — по ней видно, растёт монета за день или падает
    const back = wDay[0];
    if (!back || !(back.cl > 0)) continue;
    const chg24 = (px / back.cl - 1) * 100;

    const tp = px * (1 + NEED / 100);
    let hit = false, worst = 0, last = null;
    for (let k = i + 1; k < cs.length; k++) {
      const mins = (cs[k].t - t0) / 60;
      if (mins + 5 > 60) break;
      const d = (cs[k].lo / px - 1) * 100; if (d < worst) worst = d;
      if (!hit && cs[k].hi >= tp) hit = true;
      last = cs[k].cl;
    }
    if (last == null) continue;
    rows.push({ coin, chg24, fall, pull: fallPct(hi30, px), hit, m60: (last / px - 1) * 100, mae: worst });
  }
}

const stat = (list) => {
  if (list.length < 100) return null;
  const n = list.length;
  const avg = f => list.reduce((s, x) => s + f(x), 0) / n;
  const share = f => list.filter(f).length / n * 100;
  // Ошибка по монетам: точки внутри монеты не независимы
  const per = {};
  for (const r of list) (per[r.coin] = per[r.coin] || []).push(r);
  const parts = Object.values(per).filter(a => a.length >= 30)
    .map(a => a.reduce((s, x) => s + x.m60, 0) / a.length);
  let se = null;
  if (parts.length >= 8) {
    const m = parts.reduce((s, x) => s + x, 0) / parts.length;
    const sd = Math.sqrt(parts.reduce((s, x) => s + (x - m) ** 2, 0) / (parts.length - 1));
    se = sd / Math.sqrt(parts.length);
  }
  return { n, coins: parts.length, hit: share(r => r.hit), m60: avg(r => r.m60), se,
    mae: avg(r => r.mae), bad3: share(r => r.mae <= -3), bad5: share(r => r.mae <= -5) };
};

const show = (label, list) => {
  const s = stat(list);
  if (!s) { console.log('  ' + label.padEnd(26) + 'мало (' + list.length + ')'); return; }
  console.log('  ' + label.padEnd(26) + String(s.n).padStart(7) +
    s.hit.toFixed(0).padStart(8) + '%' +
    s.m60.toFixed(3).padStart(9) + '%' + (s.se ? ' ±' + s.se.toFixed(2) : '      ') +
    s.mae.toFixed(2).padStart(9) + '%' +
    s.bad3.toFixed(1).padStart(8) + '%' + s.bad5.toFixed(1).padStart(7) + '%');
};

console.log('\nмонет ' + coins + ', точек входа (падение от суток ' + GATE_FALL + '%+): ' + rows.length);
console.log('\n  за сутки к моменту входа        n   дошли    через час        просадка   ниже −3%  ниже −5%');
show('выросла больше +10%', rows.filter(r => r.chg24 > 10));
show('выросла +3…+10%', rows.filter(r => r.chg24 > 3 && r.chg24 <= 10));
show('около нуля −3…+3%', rows.filter(r => r.chg24 >= -3 && r.chg24 <= 3));
show('упала −3…−10%', rows.filter(r => r.chg24 < -3 && r.chg24 >= -10));
show('упала больше −10%', rows.filter(r => r.chg24 < -10));

console.log('\nТо же, но только с откатом от 1.5% (зелёная подсветка в панели):');
const deep = rows.filter(r => r.pull >= DEEP);
console.log('  за сутки к моменту входа        n   дошли    через час        просадка   ниже −3%  ниже −5%');
show('выросла больше +10%', deep.filter(r => r.chg24 > 10));
show('выросла +3…+10%', deep.filter(r => r.chg24 > 3 && r.chg24 <= 10));
show('около нуля −3…+3%', deep.filter(r => r.chg24 >= -3 && r.chg24 <= 3));
show('упала −3…−10%', deep.filter(r => r.chg24 < -3 && r.chg24 >= -10));
show('упала больше −10%', deep.filter(r => r.chg24 < -10));
