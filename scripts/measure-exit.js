// Цель продажи: какая окупается, а какая нет.
//
// Вход мы измерили насквозь, а выход ни разу: в настройках стоит цель +1%, и
// это число никем не проверялось. Меряем тем же способом и на тех же свечах.
//
// Правило: купили по цене закрытия свечи (по рынку, комиссия тейкера), ждём.
// Дошла цена до цели — продали лимиткой на цели (комиссия мейкера). Не дошла
// за отведённый срок — продали по рынку по цене закрытия (снова тейкер).
//
// Комиссии из настроек сервера: рынок 0.15%, лимитка 0.075%.
const fs = require('fs'), path = require('path');
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
const F_MKT = 0.0015, F_LIM = 0.00075;
const GATE = 3, DEEP = 1.5, DAY = 288;
const TARGETS = [0.3, 0.5, 0.75, 1, 1.5, 2, 3];
const HOURS = [1, 4, 8, 24];
const MAXH = Math.max(...HOURS);
const fallPct = (h, p) => (h - p) / h * 100;

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
const pts = [];
let coins = 0;
for (const coin in cache) {
  const cs = cache[coin];
  if (!cs || cs.length < DAY * 2 + MAXH * 12 + 20) continue;
  coins++;
  for (let i = DAY; i < cs.length - MAXH * 12 - 1; i += 3) {
    const px = cs[i].cl;
    if (!(px > 0)) continue;
    const t0 = cs[i].t;
    const w30 = cs.slice(Math.max(0, i - 40), i + 1).filter(c => t0 - c.t <= 30 * 60);
    const wd = cs.slice(Math.max(0, i - DAY * 3), i + 1).filter(c => t0 - c.t <= 24 * 3600);
    if (w30.length < 2 || wd.length < 30) continue;
    const hi30 = Math.max(...w30.map(c => c.hi)), hd = Math.max(...wd.map(c => c.hi));
    if (!(hi30 > 0) || !(hd > 0)) continue;
    const fall = fallPct(hd, px);
    const back = wd[0];
    if (!back || !(back.cl > 0)) continue;
    const chg24 = (px / back.cl - 1) * 100;
    const pull = fallPct(hi30, px);

    // Один проход вперёд: когда впервые задета каждая цель и какая цена на
    // каждом сроке. Дальше из этого собираются все правила разом.
    const firstHit = new Array(TARGETS.length).fill(null);
    const closeAt = new Array(HOURS.length).fill(null);
    for (let k = i + 1; k < cs.length; k++) {
      // Время в кеше — в СЕКУНДАХ. С делением на миллисекунды час
      // получался нулём, окно не закрывалось никогда, и «за час» считалось
      // по всем оставшимся суткам: отсюда 99% дошедших и одинаковые столбцы.
      const h = (cs[k].t - t0) / 3600;
      if (h > MAXH) break;
      for (let ti = 0; ti < TARGETS.length; ti++) {
        if (firstHit[ti] == null && cs[k].hi >= px * (1 + TARGETS[ti] / 100)) firstHit[ti] = h;
      }
      for (let hi = 0; hi < HOURS.length; hi++) {
        if (h <= HOURS[hi]) closeAt[hi] = cs[k].cl;
      }
    }
    if (closeAt[0] == null) continue;
    pts.push({ coin, fall, pull, chg24, px, firstHit, closeAt });
  }
}

// Итог сделки в процентах, с комиссиями
const netHit = (t) => (1 + t / 100) * (1 - F_LIM) / (1 + F_MKT) - 1;
const netOut = (px, pc) => (pc / px) * (1 - F_MKT) / (1 + F_MKT) - 1;

const stat = (list, ti, hi) => {
  if (list.length < 200) return null;
  const per = {};
  let hits = 0;
  const vals = [];
  for (const p of list) {
    const h = p.firstHit[ti];
    const pc = p.closeAt[hi];
    if (pc == null) continue;
    const hit = h != null && h <= HOURS[hi];
    if (hit) hits++;
    const v = (hit ? netHit(TARGETS[ti]) : netOut(p.px, pc)) * 100;
    vals.push(v);
    (per[p.coin] = per[p.coin] || []).push(v);
  }
  if (vals.length < 200) return null;
  const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
  // Ошибка по монетам: точки внутри монеты не независимы
  const parts = Object.values(per).filter(a => a.length >= 30).map(a => a.reduce((s, x) => s + x, 0) / a.length);
  let se = null;
  if (parts.length >= 8) {
    const m = parts.reduce((s, x) => s + x, 0) / parts.length;
    const sd = Math.sqrt(parts.reduce((s, x) => s + (x - m) ** 2, 0) / (parts.length - 1));
    se = sd / Math.sqrt(parts.length);
  }
  return { n: vals.length, hit: hits / vals.length * 100, avg, se, coins: parts.length };
};

const table = (label, list) => {
  console.log('\n' + label + '  (' + list.length + ' точек)');
  console.log('  цель      ' + HOURS.map(h => (h + ' ч').padStart(16)).join(''));
  for (let ti = 0; ti < TARGETS.length; ti++) {
    let line = '  +' + String(TARGETS[ti] + '%').padEnd(8);
    for (let hi = 0; hi < HOURS.length; hi++) {
      const s = stat(list, ti, hi);
      line += s ? (s.avg.toFixed(3) + '%').padStart(9) + (' ' + s.hit.toFixed(0) + '%').padStart(7)
        : 'мало'.padStart(16);
    }
    console.log(line);
  }
  // Ошибка для лучшей клетки, чтобы было видно, значима ли разница
  let best = null;
  for (let ti = 0; ti < TARGETS.length; ti++) for (let hi = 0; hi < HOURS.length; hi++) {
    const s = stat(list, ti, hi);
    if (s && (!best || s.avg > best.s.avg)) best = { ti, hi, s };
  }
  if (best) {
    console.log('  лучшая: цель +' + TARGETS[best.ti] + '% за ' + HOURS[best.hi] + ' ч → ' +
      best.s.avg.toFixed(3) + '% ±' + (best.s.se == null ? '?' : best.s.se.toFixed(3)) +
      ' (доходят ' + best.s.hit.toFixed(0) + '%, ' + best.s.coins + ' монет)');
  }
};

console.log('монет ' + coins + ', точек входа ' + pts.length +
  '; комиссии: рынок ' + (F_MKT * 100) + '%, лимитка ' + (F_LIM * 100) + '%');
console.log('в каждой клетке: средний итог сделки и доля дошедших до цели');
// КОНТРОЛЬ. Без него таблица говорит не о правиле, а о том, куда шёл рынок
// за эти 25 суток: длинный срок и высокая цель выигрывают у любой точки, если
// рынок в целом рос.
table('КОНТРОЛЬ: точки, НЕ прошедшие вход (падение меньше 3%)', pts.filter(p => p.fall < GATE));
table('ВСЕ, кто прошёл вход (падение 3%+)', pts.filter(p => p.fall >= GATE));
table('УРОВЕНЬ «БРАТЬ»: откат от 1.5% и ход за сутки в пределах ±10%',
  pts.filter(p => p.fall >= GATE && p.pull >= DEEP && Math.abs(p.chg24) < 10));
table('УРОВЕНЬ «МОЖНО»: откат мельче 1.5%, ход за сутки спокойный',
  pts.filter(p => p.fall >= GATE && p.pull < DEEP && Math.abs(p.chg24) < 10));
table('УРОВЕНЬ «РИСК»: за сутки прошла больше ±10%',
  pts.filter(p => p.fall >= GATE && Math.abs(p.chg24) >= 10));
