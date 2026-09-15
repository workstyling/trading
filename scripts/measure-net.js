// Что даёт покупка по отбору панели ПОСЛЕ ИЗДЕРЖЕК — и есть ли клетка,
// которую можно разрешить к покупке.
//
// Панель показывает частоту касания цели +0.30% за час. Круговой оборот
// стоит столько же: 0.15% тейкером в каждую сторону, 0.075% мейкером. То
// есть сама по себе частота не обещает ничего — она обязана сравниваться с
// ценой входа и выхода, иначе список выглядит как список для покупки, будучи
// списком наблюдения.
//
// Здесь считается не частота, а результат сделки. Вход по цене закрытия
// свечи, выход по цели лимитом (мейкер), а если цель не взята — по цене в
// конце горизонта маркетом (тейкер), стоп маркетом. Рядом идёт контрольная
// группа: те же монеты и те же моменты, но без условия панели. Если отбор
// ничего не даёт, обе колонки совпадут.
//
// РАЗРЕШЕНИЕ НА ПОКУПКУ выдаётся клетке только если она в плюсе с запасом в
// две ошибки на ПЕРВОЙ половине периода И повторила это на второй. Порог
// записан здесь заранее, до того как посмотрели на числа: иначе он всегда
// окажется чуть ниже лучшего результата, который удалось найти.
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
const DEEP = 1.5;                        // порог «глубокого» отката, как в панели
const BANDS = [3, 6, 10];                // нижние границы клеток падения

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

// Один проход по свечам: для каждого входа — его клетка и результат всех режимов
function entries() {
  const byCoin = {};
  let from = Infinity, to = 0;
  for (const coin in cache) {
    const cs = cache[coin];
    if (!cs || cs.length < 400) continue;
    const ok = cs.filter(c => Number.isFinite(c.t) && c.lo > 0 && c.hi >= c.lo &&
      c.cl >= c.lo && c.cl <= c.hi).sort((a, b) => a.t - b.t);
    const rows = [];
    // Шаг в час: соседние входы одной монеты перекрываются горизонтами, и
    // мельче шаг только раздувает число «сделок», не добавляя сведений.
    for (let i = 288; i + 12 < ok.length; i += 12) {
      const t0 = ok[i].t;
      const day = ok.slice(i - 288, i + 1).filter(c => t0 - c.t <= 86400);
      if (day.length < 30 || (t0 - day[0].t) < 20 * 3600) continue;
      const px = ok[i].cl;
      const hiD = Math.max(...day.map(c => c.hi));
      if (!(hiD > 0 && px > 0)) continue;
      const half = ok.slice(Math.max(0, i - 6), i + 1);
      const hi30 = Math.max(...half.map(c => c.hi));
      const fall = (hiD - px) / hiD * 100;
      const pull = hi30 > 0 ? (hi30 / px - 1) * 100 : 0;
      const net = {};
      for (const h of HOURS) {
        const future = ok.slice(i + 1, i + 1 + h * 12);
        const whole = future.length === h * 12 && !future.some((c, j) => c.t !== t0 + (j + 1) * 300);
        for (const target of TARGETS) {
          if (!whole) { net[h + '|' + target] = null; continue; }
          const up = px * (1 + target / 100), dn = px * (1 - STOP / 100);
          let v = null;
          for (const c of future) {
            // Порядок внутри свечи неизвестен: при касании обеих границ
            // считаем худшее — сначала стоп.
            if (c.lo <= dn) { v = -STOP - 2 * TAKER; break; }
            if (c.hi >= up) { v = target - TAKER - MAKER; break; }
          }
          net[h + '|' + target] = v == null
            ? (future[future.length - 1].cl / px - 1) * 100 - 2 * TAKER : v;
        }
      }
      rows.push({ t: t0 * 1000, fall, pull, net });
      from = Math.min(from, t0 * 1000); to = Math.max(to, t0 * 1000);
    }
    if (rows.length) byCoin[coin] = rows;
  }
  return { byCoin, from, to };
}

// Итог по выборке: pick отбирает входы, key называет режим
function measure(byCoin, pick, key) {
  const parts = [];
  for (const coin in byCoin) {
    const rows = byCoin[coin].filter(r => r.net[key] != null && pick(r));
    if (rows.length < MIN_PER_COIN) continue;
    parts.push({ m: rows.reduce((s, r) => s + r.net[key], 0) / rows.length, n: rows.length });
  }
  return pool(parts);
}

const { byCoin, from, to } = entries();
const day = ms => Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?';
const MID = from + (to - from) / 2;
const halves = {
  A: (r) => r.t < MID,
  B: (r) => r.t >= MID,
  all: () => true,
};

console.log('вход по цене, стоп -' + STOP + '%, комиссии мейкер ' + MAKER + '% / тейкер ' + TAKER + '%');
console.log('окно ' + day(from) + ' — ' + day(to) + ', монет в кеше ' + Object.keys(cache).length);
console.log('\nгоризонт цель   панель (падение от ' + GATE + '%)      контроль (без условий)       разница');

const rows = [];
for (const h of HOURS) {
  for (const target of TARGETS) {
    const key = h + '|' + target;
    const a = measure(byCoin, r => r.fall >= GATE, key);
    const b = measure(byCoin, () => true, key);
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

// ── разрешение на покупку по клеткам ────────────────────────────────────────
//
// Клетке разрешается покупка, только если на ОБЕИХ половинах периода её
// результат положителен с запасом в две ошибки. Одной половины мало: в
// прошлый раз четыре признака обогнали базу на августе и все развернулись в
// сентябре.
console.log('\nразрешение на покупку по клеткам (плюс на обеих половинах, запас две ошибки)');
console.log('поиск ' + day(from) + '—' + day(MID) + ', проверка ' + day(MID) + '—' + day(to));
const buyCells = [];
let checked = 0;
for (const lo of BANDS) {
  const hi = BANDS[BANDS.indexOf(lo) + 1] ?? Infinity;
  for (const deep of [false, true]) {
    const pick = r => r.fall >= lo && r.fall < hi && (r.pull >= DEEP) === deep;
    let best = null, closest = null;
    for (const h of HOURS) {
      for (const target of TARGETS) {
        const key = h + '|' + target;
        const A = measure(byCoin, r => halves.A(r) && pick(r), key);
        const B = measure(byCoin, r => halves.B(r) && pick(r), key);
        if (!A || !B) continue;
        checked++;
        // Самый близкий к порогу режим показываем даже когда он не прошёл:
        // «не разрешена» без числа не отличить от «не считали», и не видно,
        // на сколько клетка промахнулась.
        const worst = Math.min(A.m, B.m);
        if (!closest || worst > closest.worst) closest = { horizonH: h, target, A, B, worst };
        if (!(A.m - 2 * A.se > 0 && B.m - 2 * B.se > 0)) continue;
        // Из прошедших берём самый осторожный: худшую из двух половин
        if (!best || worst > best.worst) best = { horizonH: h, target, A, B, worst };
      }
    }
    const label = (hi === Infinity ? '>' + lo : lo + '-' + hi) + '%' + (deep ? ' откат>' + DEEP : ' откат<' + DEEP);
    if (best) {
      buyCells.push({ lo, deep, horizonH: best.horizonH, target: best.target,
        netA: Math.round(best.A.m * 1000) / 1000, seA: Math.round(best.A.se * 1000) / 1000,
        netB: Math.round(best.B.m * 1000) / 1000, seB: Math.round(best.B.se * 1000) / 1000,
        n: best.A.n + best.B.n });
      console.log('  ' + label.padEnd(22) + 'РАЗРЕШЕНА: ' + best.horizonH + 'ч, цель ' + best.target +
        '% — поиск +' + best.A.m.toFixed(3) + ' ±' + best.A.se.toFixed(3) +
        ', проверка +' + best.B.m.toFixed(3) + ' ±' + best.B.se.toFixed(3));
    } else if (closest) {
      const need = (c) => (c.m >= 0 ? '+' : '') + c.m.toFixed(3) + ' ±' + c.se.toFixed(3);
      console.log('  ' + label.padEnd(22) + 'не разрешена. Ближе всех ' + closest.horizonH + 'ч/цель ' +
        closest.target + '%: поиск ' + need(closest.A) + ', проверка ' + need(closest.B) +
        ' (нужен плюс с запасом две ошибки в обеих)');
    } else {
      console.log('  ' + label.padEnd(22) + 'не разрешена: данных не хватает ни на один режим');
    }
  }
}

const plus = rows.filter(r => r.panel.m - 2 * r.panel.se > 0);
console.log('\nрежимов, где отбор лучше случайного входа: ' + rows.filter(r => r.better).length + ' из ' + rows.length);
console.log('режимов, где отбор в плюсе после издержек: ' + plus.length + ' из ' + rows.length);
console.log('клеток, разрешённых к покупке: ' + buyCells.length + ' (проверено сочетаний ' + checked + ')');
if (!buyCells.length) {
  console.log('\nПОКУПАТЬ ПО ЭТОМУ ОТБОРУ НЕЛЬЗЯ: ни одна клетка не окупает издержки дважды.');
  console.log('Это измерение периода, а не приговор правилу: исходная сетка мерилась');
  console.log('на растущем рынке, здесь окно падающего.');
}
const best = rows.slice().sort((a, b) => b.panel.m - a.panel.m)[0];
if (best) console.log('\nлучший режим отбора: ' + best.h + 'ч, цель ' + best.target + '% — ' +
  (best.panel.m >= 0 ? '+' : '') + best.panel.m.toFixed(3) + '% ±' + best.panel.se.toFixed(3) + ' за сделку');

const hour = rows.find(r => r.h === 1 && r.target === 0.3);
if (hour) {
  console.log('\nдля ENTRY_NET в server.js:');
  console.log(JSON.stringify({ at: day(Date.now()), from: day(from), to: day(to), splitAt: day(MID),
    horizonH: 1, target: 0.3,
    panel: Math.round(hour.panel.m * 1000) / 1000, panelSe: Math.round(hour.panel.se * 1000) / 1000,
    control: Math.round(hour.control.m * 1000) / 1000, controlSe: Math.round(hour.control.se * 1000) / 1000,
    n: hour.panel.n, controlN: hour.control.n,
    betterModes: rows.filter(r => r.better).length, plusModes: plus.length, modes: rows.length,
    buyCells }));
}
process.exitCode = buyCells.length ? 0 : 3;
