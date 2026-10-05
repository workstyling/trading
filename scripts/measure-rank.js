// ЧТО ДЕЛАЕТ СТРОКУ «ЛУЧШЕ БРАТЬ» — ПРЕДРЕГИСТРИРОВАННАЯ ПРОВЕРКА ПОРЯДКА.
//
// Порядок списка по частоте касания цели уже проверен (ENTRY_FREQ_RANK): верх
// не лучше низа по деньгам. Чтобы «выше — значит лучше брать» было правдой,
// ключ сортировки обязан предсказывать РЕЗУЛЬТАТ СДЕЛКИ после комиссий на
// данных, которых он не видел. Здесь проверяются два кандидата.
//
// Записано ДО прогона:
//   режим сделки — тот же, что у панели: вход по цене, цель +0.30% за час,
//   стоп −3%, комиссии мейкер 0.075% / тейкер 0.15%; входы — гейт панели
//   (падение от суточного пика от 3%, |ход за сутки| < 10%), шаг час.
//   (A) ГРУППА: падение 3–6 / 6–10 / от 10% × откат за 30 мин <1.5 / 1.5–3 / от 3%.
//       На первой половине периода группы ранжируются по среднему результату;
//       на второй сравнивается верхняя треть групп с нижней третью.
//   (B) МОНЕТА: средний результат монеты на первой половине; на второй
//       сравниваются монеты верхней половины с нижней.
//   Ключ ПОДТВЕРЖДЁН, если на второй половине верх лучше низа больше чем на
//   две ошибки разности. Иначе ключ сортировки не получает.
//
// Свечи — кеш сверки (node scripts/recheck-recovery.js). Запуск: node scripts/measure-rank.js
const fs = require('fs');
const path = require('path');

const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
const MAKER = 0.075, TAKER = 0.15, STOP = 3, TARGET = 0.3, HOURS = 1;
const GATE = 3, SWING = 10, MIN_PER_COIN = 15, MIN_COINS = 12;

let cache;
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); }
catch { console.log('ПЛОХО: нет кеша свечей. Сначала: node scripts/recheck-recovery.js'); process.exit(1); }

const band = f => f >= 10 ? 10 : f >= 6 ? 6 : f >= GATE ? 3 : null;
const pullBand = p => p >= 3 ? 'steep' : p >= 1.5 ? 'deep' : 'shallow';

// Входы — так же, как в measure-net.js: свеча закрытия, шаг час, худший порядок внутри свечи.
const byCoin = {};
let from = Infinity, to = 0;
for (const coin in cache) {
  const cs = cache[coin];
  if (!cs || cs.length < 400) continue;
  const ok = cs.filter(c => Number.isFinite(c.t) && c.lo > 0 && c.hi >= c.lo && c.cl >= c.lo && c.cl <= c.hi).sort((a, b) => a.t - b.t);
  const rows = [];
  for (let i = 288; i + 12 < ok.length; i += 12) {
    const t0 = ok[i].t;
    const day = ok.slice(i - 288, i + 1).filter(c => t0 - c.t <= 86400);
    if (day.length < 30 || (t0 - day[0].t) < 20 * 3600) continue;
    const px = ok[i].cl, hiD = Math.max(...day.map(c => c.hi));
    if (!(hiD > 0 && px > 0) || !(day[0].cl > 0)) continue;
    const fall = (hiD - px) / hiD * 100;
    const chg = (px / day[0].cl - 1) * 100;
    if (band(fall) == null || Math.abs(chg) >= SWING) continue;
    const hi30 = Math.max(...ok.slice(Math.max(0, i - 6), i + 1).map(c => c.hi));
    const pull = hi30 > 0 ? (hi30 / px - 1) * 100 : 0;
    const future = ok.slice(i + 1, i + 1 + HOURS * 12);
    if (future.length !== HOURS * 12 || future.some((c, j) => c.t !== t0 + (j + 1) * 300)) continue;
    const up = px * (1 + TARGET / 100), dn = px * (1 - STOP / 100);
    let net = null;
    for (const c of future) {
      if (c.lo <= dn) { net = -STOP - 2 * TAKER; break; }
      if (c.hi >= up) { net = TARGET - TAKER - MAKER; break; }
    }
    if (net == null) net = (future[future.length - 1].cl / px - 1) * 100 - 2 * TAKER;
    rows.push({ t: t0 * 1000, cell: band(fall) + '|' + pullBand(pull), net });
    from = Math.min(from, t0 * 1000); to = Math.max(to, t0 * 1000);
  }
  if (rows.length) byCoin[coin] = rows;
}
const MID = from + (to - from) / 2;
const day = ms => new Date(ms).toISOString().slice(0, 10);
const A = r => r.t < MID, B = r => r.t >= MID;

// Среднее с ошибкой по монетам (точки внутри монеты не независимы).
function pooled(pick) {
  const parts = [];
  for (const coin in byCoin) {
    const rows = byCoin[coin].filter(pick);
    if (rows.length < MIN_PER_COIN) continue;
    parts.push({ m: rows.reduce((s, r) => s + r.net, 0) / rows.length, n: rows.length });
  }
  if (parts.length < MIN_COINS) return null;
  const total = parts.reduce((s, x) => s + x.n, 0);
  const m = parts.reduce((s, x) => s + x.m * x.n, 0) / total;
  const se = Math.sqrt(parts.length / (parts.length - 1) * parts.reduce((s, x) => s + ((x.m - m) * x.n / total) ** 2, 0));
  return { m, se, n: total, coins: parts.length };
}
const f = v => (v >= 0 ? '+' : '') + v.toFixed(3);
const verdictOf = (top, bot) => {
  if (!top || !bot) return { diff: null, se: null, verdict: 'мало данных' };
  const diff = top.m - bot.m, se = Math.sqrt(top.se ** 2 + bot.se ** 2);
  return { diff, se, verdict: diff > 2 * se ? 'ПОДТВЕРЖДЁН' : diff < -2 * se ? 'НАОБОРОТ' : 'ноль' };
};

console.log('окно ' + day(from) + ' — ' + day(to) + ', поиск до ' + day(MID) + ', проверка после');
console.log('режим: 1ч, цель +0.30%, стоп −3%, комиссии внутри; гейт панели\n');

// (A) группы
const cells = [...new Set(Object.values(byCoin).flat().map(r => r.cell))];
const ranked = cells.map(cell => ({ cell, a: pooled(r => A(r) && r.cell === cell), b: pooled(r => B(r) && r.cell === cell) }))
  .filter(x => x.a).sort((x, y) => y.a.m - x.a.m);
console.log('(A) группы по результату на поиске:');
for (const x of ranked) console.log('  ' + x.cell.padEnd(12) + ' поиск ' + f(x.a.m) + ' ±' + x.a.se.toFixed(3) +
  '   проверка ' + (x.b ? f(x.b.m) + ' ±' + x.b.se.toFixed(3) : 'мало данных'));
const third = Math.max(1, Math.floor(ranked.length / 3));
const topCells = new Set(ranked.slice(0, third).map(x => x.cell));
const botCells = new Set(ranked.slice(-third).map(x => x.cell));
const vA = verdictOf(pooled(r => B(r) && topCells.has(r.cell)), pooled(r => B(r) && botCells.has(r.cell)));
console.log('  верх (' + [...topCells].join(', ') + ') против низа (' + [...botCells].join(', ') + ') на проверке: ' +
  (vA.diff == null ? 'мало данных' : f(vA.diff) + ' ±' + vA.se.toFixed(3)) + ' — ' + vA.verdict);

// (B) монеты
const coinA = Object.entries(byCoin).map(([coin, rows]) => {
  const r = rows.filter(A);
  return r.length >= MIN_PER_COIN ? { coin, m: r.reduce((s, x) => s + x.net, 0) / r.length } : null;
}).filter(Boolean).sort((x, y) => y.m - x.m);
const halfN = Math.floor(coinA.length / 2);
const topCoins = new Set(coinA.slice(0, halfN).map(x => x.coin));
const botCoins = new Set(coinA.slice(-halfN).map(x => x.coin));
const pick = set => { const save = {}; for (const c in byCoin) if (!set.has(c)) { save[c] = byCoin[c]; } return save; };
const only = (set) => r => B(r) && set.has(r.coin);
for (const coin in byCoin) for (const r of byCoin[coin]) r.coin = coin;
const vB = verdictOf(pooled(only(topCoins)), pooled(only(botCoins)));
console.log('\n(B) монеты: верхняя половина по поиску (' + topCoins.size + ') против нижней (' + botCoins.size + ') на проверке: ' +
  (vB.diff == null ? 'мало данных' : f(vB.diff) + ' ±' + vB.se.toFixed(3)) + ' — ' + vB.verdict);

console.log('\nдля ENTRY_RANK в server.js:');
const round = v => v == null ? null : Math.round(v * 1000) / 1000;
console.log(JSON.stringify({ at: day(Date.now()), from: day(from), to: day(to), splitAt: day(MID),
  cell: { top: [...topCells], bottom: [...botCells], diff: round(vA.diff), se: round(vA.se), verdict: vA.verdict,
    table: ranked.map(x => ({ cell: x.cell, a: round(x.a.m), aSe: round(x.a.se), b: x.b ? round(x.b.m) : null, bSe: x.b ? round(x.b.se) : null })) },
  coin: { diff: round(vB.diff), se: round(vB.se), verdict: vB.verdict } }));
process.exitCode = vA.verdict === 'ПОДТВЕРЖДЁН' || vB.verdict === 'ПОДТВЕРЖДЁН' ? 0 : 3;
