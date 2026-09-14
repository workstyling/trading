// Свободные места лаборатории достаются тем, кто может войти.
//
// Список кандидатов сначала обрезался по числу свободных мест, а проверки
// «монета уже открыта» и «ещё идёт перерыв» выполнялись позже, внутри
// прохода. При лимите в две позиции, открытой A и кандидатах [A, B] брался
// только A, затем отбрасывался как уже открытый — и B не рассматривался,
// хотя место было свободно.
//
// Это меняет состав экспериментальной выборки, а она и есть предмет
// эксперимента: пропускались как раз те кандидаты, что шли следом за уже
// открытыми.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('src/micro-scalp/lab.js', 'utf8').split('\r\n').join('\n');

// Берём только отбор кандидатов: остальное в лаборатории ходит на биржу
function build(state, maxOpen, cooldownMs) {
  const ctx = { Date, Set, state, maxOpen, cooldownMs, isCurrent: () => true, console };
  vm.createContext(ctx);
  const i = src.indexOf('  function coolingDown(coin) {');
  const j = src.indexOf('  async function tick(');
  vm.runInContext(src.slice(i, j) + ';this.canEnter = canEnter;', ctx);
  return ctx;
}

const now = Date.now();
const scanAt = now - 1000;
const cand = (coin) => ({ coin, pair: coin + '-USD', pass: true });

console.log('\nЗанятое место не съедает кандидата');
{
  // Ровно случай из проверки: лимит два, открыта A, кандидаты [A, B]
  const state = { enabled: true, trades: [{ coin: 'A', openedAt: now - 1000 }] };
  const ctx = build(state, 2, 90 * 60000);
  const got = ctx.canEnter([cand('A'), cand('B')], scanAt).map(c => c.coin);
  ok(got.join(',') === 'B', 'вместо уже открытой A взята B', got.join(',') || 'пусто');
}

console.log('\nОстальные условия');
{
  const state = { enabled: true, trades: [] };
  const ctx = build(state, 2, 90 * 60000);
  ok(ctx.canEnter([cand('A'), cand('B'), cand('C')], scanAt).length === 2,
    'больше свободных мест не берётся');
  ok(ctx.canEnter([{ coin: 'A', pass: false }, cand('B')], scanAt).map(c => c.coin).join(',') === 'B',
    'не прошедшие гейт не занимают место');

  // Монета на перерыве после закрытия тоже не должна занимать место
  const cooling = { enabled: true, trades: [{ coin: 'A', closedAt: now - 60000 }] };
  const ctx2 = build(cooling, 2, 90 * 60000);
  ok(ctx2.canEnter([cand('A'), cand('B')], scanAt).map(c => c.coin).join(',') === 'B',
    'монета на перерыве пропускается сразу, а не после обрезки');
  // А когда перерыв вышел — берётся снова
  const cooled = { enabled: true, trades: [{ coin: 'A', closedAt: now - 100 * 60000 }] };
  const ctx3 = build(cooled, 2, 90 * 60000);
  ok(ctx3.canEnter([cand('A')], scanAt).map(c => c.coin).join(',') === 'A', 'после перерыва монета доступна');

  // Мест нет — не берём никого
  const full = { enabled: true, trades: [{ coin: 'X' }, { coin: 'Y' }] };
  ok(build(full, 2, 90 * 60000).canEnter([cand('B')], scanAt).length === 0, 'при занятых местах никого');

  // Выключенная лаборатория и устаревший скан
  ok(build({ enabled: false, trades: [] }, 2, 1).canEnter([cand('B')], scanAt).length === 0, 'выключенная молчит');
  ok(build({ enabled: true, trades: [] }, 2, 1).canEnter([cand('B')], now - 5 * 60000).length === 0,
    'по устаревшему скану не входим');
}

console.log('\nПроверки в проходе остались как защита');
{
  const tick = src.slice(src.indexOf('async function tick('));
  ok(/trade\.coin === candidate\.coin && !trade\.closedAt/.test(tick), 'повторная проверка открытой монеты на месте');
  ok(/Date\.now\(\) - recent\.closedAt < cooldownMs/.test(tick), 'и перерыва тоже');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
