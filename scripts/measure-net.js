// Что даёт покупка по отбору панели ПОСЛЕ ИЗДЕРЖЕК.
//
// Панель показывает частоту касания цели +0.30% за час. Круговой оборот
// стоит столько же: 0.15% тейкером в каждую сторону, 0.075% мейкером. То
// есть сама по себе частота не обещает ничего — она обязана сравниваться с
// ценой входа и выхода, иначе список выглядит как список для покупки, будучи
// списком наблюдения.
//
// Здесь считается не частота, а результат сделки. Вход по цене закрытия
// свечи, выход по цели лимитом (мейкер), а если цель не взята — по цене в
// конце горизонта маркетом (тейкер). Рядом идёт контрольная группа: те же
// монеты и те же моменты, но без условия панели. Если отбор ничего не даёт,
// обе колонки совпадут.
//
// Свечи берутся из кеша сверки сетки. Сначала: node scripts/recheck-recovery.js
// Запуск: node scripts/measure-net.js [--gate 3] [--stop 3]
const fs = require('fs');
const path = require('path');

const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
const MAKER = 0.075, TAKER = 0.15;       // как в боевых настройках
const MIN_PER_COIN = 15;                 // меньше — доля монеты слишком шумная
const MIN_COINS = 12;                    // меньше — по режиму нечего говорить
const HOURS = [1, 4, 12, 24];
const TARGETS = [0.3, 1, 2, 3];

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : def;
};
const GATE = arg('gate', 3);             // падение от суточного пика, как в панели
const STOP = arg('stop', 3);             // выход по стопу маркетом

let cache;
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); }
catch { console.log('ПЛОХО: нет кеша свечей. Сначала: node scripts/recheck-recovery.js'); process.exit(1); }

// Доля монеты считается отдельно, и уже доли складываются с весом: точки
// внутри одной монеты не независимы, и ошибка по точкам занижена в разы.
function pool(parts) {
  if (parts.length < MIN_COINS) return null;
  const total = parts.reduce((s, x) => s + x.n, 0);
  const m = parts.reduce((s, x) => s + x.m * x.n, 0) / total;
  const se = Math.sqrt(parts.length / (parts.length - 1) *
    parts.reduce((s, x) => s + ((x.m - m) * x.n / total) ** 2, 0));
  return { m, se, n: total, coins: parts.length };
}

function walk(gate) {
  const parts = {};
  let from = Infinity, to = 0;
  for (const coin in cache) {
    const cs = cache[coin];
    if (!cs || cs.length < 400) continue;
    const ok = cs.filter(c => Number.isFinite(c.t) && c.lo > 0 && c.hi >= c.lo &&
      c.cl >= c.lo && c.cl <= c.hi).sort((a, b) => a.t - b.t);
    const acc = {};
    // Шаг в час: соседние входы одной монеты перекрываются горизонтами, и
    // мельче шаг только раздувает число «сделок», не добавляя сведений.
    for (let i = 288; i + 12 < ok.length; i += 12) {
      const t0 = ok[i].t;
      const day = ok.slice(i - 288, i + 1).filter(c => t0 - c.t <= 86400);
      if (day.length < 30 || (t0 - day[0].t) < 20 * 3600) continue;
      const px = ok[i].cl;
      const hiD = Math.max(...day.map(c => c.hi));
      if (!(hiD > 0 && px > 0)) continue;
      if (gate && (hiD - px) / hiD * 100 < gate) continue;
      from = Math.min(from, t0 * 1000); to = Math.max(to, t0 * 1000);
      for (const h of HOURS) {
        const future = ok.slice(i + 1, i + 1 + h * 12);
        if (future.length !== h * 12) continue;
        if (future.some((c, j) => c.t !== t0 + (j + 1) * 300)) continue;
        for (const target of TARGETS) {
          const up = px * (1 + target / 100), dn = px * (1 - STOP / 100);
          let net = null;
          for (const c of future) {
            // Порядок внутри свечи неизвестен: при касании обеих границ
            // считаем худшее — сначала стоп.
            if (c.lo <= dn) { net = -STOP - 2 * TAKER; break; }
            if (c.hi >= up) { net = target - TAKER - MAKER; break; }
          }
          if (net == null) net = (future[future.length - 1].cl / px - 1) * 100 - 2 * TAKER;
          const key = h + '|' + target;
          (acc[key] || (acc[key] = [])).push(net);
        }
      }
    }
    for (const key in acc) {
      if (acc[key].length < MIN_PER_COIN) continue;
      (parts[key] || (parts[key] = [])).push({ coin,
        m: acc[key].reduce((s, x) => s + x, 0) / acc[key].length, n: acc[key].length });
    }
  }
  const out = {};
  for (const key in parts) { const p = pool(parts[key]); if (p) out[key] = p; }
  return { out, from, to };
}

const panel = walk(GATE), control = walk(0);
const day = ms => Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?';
console.log('вход по цене, стоп -' + STOP + '%, комиссии мейкер ' + MAKER + '% / тейкер ' + TAKER + '%');
console.log('окно ' + day(panel.from) + ' — ' + day(panel.to) + ', монет в кеше ' + Object.keys(cache).length);
console.log('\nгоризонт цель   панель (падение от ' + GATE + '%)      контроль (без условий)       разница');

const rows = [];
for (const h of HOURS) {
  for (const target of TARGETS) {
    const key = h + '|' + target;
    const a = panel.out[key], b = control.out[key];
    if (!a || !b) continue;
    const diff = a.m - b.m, se = Math.sqrt(a.se * a.se + b.se * b.se);
    // Две ошибки разности — тот же порог, что у сторожа сетки.
    const mark = Math.abs(diff) > 2 * se ? (diff > 0 ? '  ЛУЧШЕ' : '  ХУЖЕ') : '  ноль';
    rows.push({ h, target, panel: a, control: b, diff, se, better: diff > 2 * se });
    console.log(String(h + 'ч').padStart(5) + String(target + '%').padStart(6) + '   ' +
      ((a.m >= 0 ? '+' : '') + a.m.toFixed(3) + '% ±' + a.se.toFixed(3) + ' (' + a.n + ')').padEnd(28) +
      ((b.m >= 0 ? '+' : '') + b.m.toFixed(3) + '% ±' + b.se.toFixed(3) + ' (' + b.n + ')').padEnd(28) +
      (diff >= 0 ? '+' : '') + diff.toFixed(3) + ' ±' + se.toFixed(3) + mark);
  }
}

const better = rows.filter(r => r.better);
const plus = rows.filter(r => r.panel.m - 2 * r.panel.se > 0);
console.log('\nрежимов, где отбор лучше случайного входа: ' + better.length + ' из ' + rows.length);
console.log('режимов, где отбор в плюсе после издержек: ' + plus.length + ' из ' + rows.length);
if (!plus.length) {
  console.log('\nПОКУПАТЬ ПО ЭТОМУ ОТБОРУ НЕЛЬЗЯ: ни один режим не окупает издержки.');
  console.log('Это измерение периода, а не приговор правилу: исходная сетка мерилась');
  console.log('на растущем рынке, здесь окно падающего.');
}
const best = rows.slice().sort((a, b) => b.panel.m - a.panel.m)[0];
if (best) console.log('\nлучший режим отбора: ' + best.h + 'ч, цель ' + best.target + '% — ' +
  (best.panel.m >= 0 ? '+' : '') + best.panel.m.toFixed(3) + '% ±' + best.panel.se.toFixed(3) + ' за сделку');
// Для ENTRY_NET в server.js
const hour = rows.find(r => r.h === 1 && r.target === 0.3);
if (hour) {
  console.log('\nдля ENTRY_NET в server.js:');
  console.log(JSON.stringify({ at: day(Date.now()), from: day(panel.from), to: day(panel.to),
    horizonH: 1, target: 0.3,
    panel: Math.round(hour.panel.m * 1000) / 1000, panelSe: Math.round(hour.panel.se * 1000) / 1000,
    control: Math.round(hour.control.m * 1000) / 1000, controlSe: Math.round(hour.control.se * 1000) / 1000,
    n: hour.panel.n, controlN: hour.control.n,
    betterModes: better.length, plusModes: plus.length, modes: rows.length }));
}
process.exitCode = plus.length ? 0 : 3;
