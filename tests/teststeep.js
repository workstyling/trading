// Резкий откат — измеренно худшее, а не кандидат.
//
// «Откат» на экране — падение от максимума последних 30 минут. Он делит сетку
// возвратов надвое и по нему же отбиралось «брать» в предрегистрированной
// проверке — той, что закончилась «преимущество не подтверждено». Стоило
// спросить прямо: что глубина отката даёт в деньгах.
//
// Замер: 81 монета, 38 714 точек, гейт панели, издержки внутри, ошибки по
// монетам; поиск на первой половине периода, проверка на второй. Два ответа:
//
//   деление на 1.5%   −0.036 ±0.034 за час — не разделяет ничего
//   откат от 3%       −0.537 ±0.094 против −0.280 ±0.006 у мелкого,
//                     разница −0.257 ±0.094, это 2.7 ошибки
//
// Сходится с отдельным замером быстрых падений: чем резче провал, тем хуже
// исход (−0.459 ±0.107). Такая строка не может носить оранжевую рамку —
// рамка зовёт смотреть именно туда, куда смотреть измеренно не надо.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');
const R = require('../public/js/recovery-journal');

const now = Date.now();
const report = { version: 2, status: 'no-drift', referenceDate: '2026-09-09', coins: 60,
  from: now - 10 * 86400000, to: now - 300000, missingCoins: [], cells: [
    { lo: 0, deep: false, actual: 65.5, se: 1.0, coins: 50, n: 9000 },
    { lo: 3, deep: false, actual: 89.0, se: 1.5, coins: 40, n: 5000 },
    { lo: 3, deep: true, actual: 84.1, se: 1.6, coins: 30, n: 3000 },
  ] };
const steepNet = { steep: { at: 3, verdict: 'хуже',
  hour: { band: -0.537, bandSe: 0.094, base: -0.280, baseSe: 0.006, diff: -0.257, se: 0.094 } } };
const scan = { recheck: { at: now, code: 0, current: true, report }, recoveryMeasuredAt: '2026-09-09',
  at: now, serverNow: now, gate: { fallPct: 3, spreadPct: 0.3 }, pullbackNet: steepNet };
const row = (coin, pullbackPct) => ({ coin, price: 1, dayFallPct: 3.1, pullbackPct,
  chg24Pct: 5, spreadPct: 0.05, inListMin: 10 });
const mark = (r, sc = scan) => {
  const obs = R.recoveryObservation(r, sc, now);
  return R.recoveryRowMark(r, sc, R.recoveryVerdict(r, { fall: 3, spread: 0.3 }, obs, null), obs, now);
};

console.log('\nСтроки из таблицы, как они есть на экране');
{
  // Настоящие числа с панели
  ok(mark(row('PYTH', 1.72)).state === 'possible', 'PYTH с откатом 1.72% остаётся кандидатом');
  ok(mark(row('DASH', 1.45)).state === 'possible', 'DASH с 1.45% тоже');
  const drv = mark(row('DRV', 3.18));
  ok(drv.state === 'none', 'DRV с откатом 3.18% кандидатом больше не считается', drv.state);
  ok(drv.label === 'резкий откат', 'и помечен своими словами', drv.label);
  ok(/2\.7|−0\.257|-0\.257/.test(drv.why) || /0\.257/.test(drv.why), 'в подсказке названа разница', drv.why.slice(0, 80));
  ok(/вне выборки/.test(drv.why), 'и что замер сделан на отложенной половине');
  ok(/издержки внутри/.test(drv.why), 'и что издержки учтены');
}

console.log('\nПорог ровно там, где измерен');
{
  ok(mark(row('X', 2.99)).state === 'possible', 'на 2.99% метки ещё нет');
  ok(mark(row('X', 3)).state === 'none', 'на ровно 3% уже есть');
  ok(mark(row('X', 12)).state === 'none', 'и глубже тоже');
}

console.log('\nБез замера панель молчит');
{
  // Порог приходит из ответа сервера. Своё число вместо измеренного — это уже
  // мнение, а панель мнений не показывает.
  const noNet = { ...scan, pullbackNet: null };
  ok(mark(row('DRV', 3.18), noNet).state === 'possible', 'нет замера — нет и метки');
  const undecided = { ...scan, pullbackNet: { steep: { at: 3, verdict: 'ноль' } } };
  ok(mark(row('DRV', 3.18), undecided).state === 'possible', 'вердикт «ноль» метку не ставит');
  const noAt = { ...scan, pullbackNet: { steep: { verdict: 'хуже' } } };
  ok(mark(row('DRV', 3.18), noAt).state === 'possible', 'без порога метку не выдумываем');
  ok(mark({ ...row('DRV', 3.18), pullbackPct: null }).state !== 'none' ||
     mark({ ...row('DRV', 3.18), pullbackPct: null }).label !== 'резкий откат',
    'без отката строка не помечается резкой');
}

console.log('\nЗамер записан в коде вместе с числами');
{
  ok(/const ENTRY_PULLBACK = \{/.test(src), 'константа замера есть');
  const block = src.slice(src.indexOf('const ENTRY_PULLBACK = {'), src.indexOf('const ENTRY_FREQ_RANK'));
  ok(/coins: 81, points: 38714/.test(block), 'названы монеты и точки');
  ok(/splitAt: '2026-08-27'/.test(block), 'и граница проверки вне выборки');
  ok(/gate: 'от пика >=3%, \|24ч\|<10%'/.test(block), 'и гейт, на котором мерили');
  ok(/deepSplit:[\s\S]{0,200}verdict: 'ноль'/.test(block),
    'деление на 1.5% записано как пустое — иначе его снова примут за смысл');
  ok(/steep:[\s\S]{0,400}verdict: 'хуже'/.test(block), 'а резкий откат — как худший');
  ok(/pullbackNet: ENTRY_PULLBACK/.test(src), 'замер уходит в панель, а не лежит мёртвым');
  // Первая половина подсказывала обратное — это записано, чтобы никто не
  // «нашёл» его снова.
  ok(/1\.5–3% выглядела ЛУЧШЕ/.test(src), 'разворот полосы 1.5–3% назван прямо');
}

console.log('\nЧисла замера сходятся сами с собой');
{
  const band = -0.537, bandSe = 0.094, base = -0.280, baseSe = 0.006;
  const diff = band - base, se = Math.sqrt(bandSe ** 2 + baseSe ** 2);
  ok(Math.abs(diff - (-0.257)) < 0.002, 'разница именно −0.257', diff.toFixed(3));
  ok(Math.abs(se - 0.094) < 0.002, 'и ошибка именно ±0.094', se.toFixed(3));
  ok(Math.abs(diff) > 2 * se, 'это больше двух ошибок', (Math.abs(diff) / se).toFixed(1) + ' ош.');
  // Деление панели — наоборот, в пределах шума
  ok(Math.abs(-0.036) < 2 * 0.034, 'а деление на 1.5% в пределах шума',
    (0.036 / 0.034).toFixed(1) + ' ош.');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
