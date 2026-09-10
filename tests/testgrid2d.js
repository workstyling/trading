// Доля возврата теперь сложена из ДВУХ признаков: глубины падения за сутки и
// отката от получасового максимума. Раньше таблица знала только глубину.
//
// Внутри каждой полосы глубины откат от 1.5% добавляет 11-18 пунктов, и
// разделение по времени это подтвердило: лучшая клетка даёт 89.6% в первой
// половине периода и 89.0% во второй против 71-72% у остального.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');
eval(src.match(/function recoveryOdds[\s\S]*?\n}/)[0]);

console.log('\nСетка: глубина × откат');
{
  const cell = (fall, pull) => recoveryOdds(fall, pull).hour;
  // Замеренные значения, 58 107 точек
  const want = [
    [4, 0.5, 66], [4, 2.0, 84],
    [8, 0.5, 73], [8, 2.0, 87],
    [15, 0.5, 78], [15, 2.0, 89],
    [2, 0.5, 57], [2, 2.0, 84],
    [0.5, 0.5, 56],
  ];
  for (const [f, p, exp] of want) {
    ok(cell(f, p) === exp, 'падение ' + f + '%, откат ' + p + '% -> ' + exp + '%', String(cell(f, p)));
  }
  // Внутри КАЖДОЙ полосы глубокий откат должен давать больше
  for (const f of [2, 4, 8, 15]) {
    ok(cell(f, 2.0) > cell(f, 0.5), 'при падении ' + f + '% откат добавляет',
      '+' + (cell(f, 2.0) - cell(f, 0.5)) + ' п.п.');
  }
  // При падении меньше процента такой клетки в замере нет — выдумывать нельзя
  ok(cell(0.5, 2.0) === 56, 'при падении меньше процента откат ничего не меняет: клетки нет в замере');
}

console.log('\nГраница ровно 1.5%');
ok(recoveryOdds(8, 1.5).hour === 87, 'ровно 1.5% считается глубоким');
ok(recoveryOdds(8, 1.49).hour === 73, 'а 1.49% — нет');
ok(recoveryOdds(8, 1.5).deep === true, 'признак отдаётся наружу');
ok(recoveryOdds(8, 1.49).deep === false, 'и в другую сторону тоже');

console.log('\nНет данных — осторожная оценка, а не хорошая новость');
for (const v of [null, undefined, '', NaN, 'мусор']) {
  ok(recoveryOdds(8, v).hour === 73, 'откат ' + JSON.stringify(v) + ' -> берётся мельче 1.5%', String(recoveryOdds(8, v).hour));
}
ok(recoveryOdds(8, null).hour < recoveryOdds(8, 2).hour, 'неизвестный откат никогда не даёт лучшую клетку');

console.log('\nОтсутствие падения по-прежнему отказ');
for (const v of [null, undefined, '']) ok(recoveryOdds(v, 2) === null, 'падение ' + JSON.stringify(v) + ' -> null');

console.log('\nСвязи в коде');
ok(/recoveryOdds\(sig\.dayFallPct, sig\.pullbackPct\)/.test(src), 'скан передаёт откат');
ok(/recoveryOdds\(t\.dayFall, t\.pullback\)/.test(src), 'журнал тоже');
ok(/pullback: row\.pullbackPct/.test(src), 'и сохраняет его в сделке');
ok(/recoveryOdds\(lo, null\)/.test(src), 'обещание полосы берётся осторожным столбцом');
ok(/const RECOVERY_SAMPLE = 58107;/.test(src), 'размер замера обновлён');
ok(/const RECOVERY_MEASURED_AT = '2026-09-09';/.test(src), 'дата тоже');

console.log('\nСортировка');
{
  const body = src.slice(src.indexOf('const recHour = r =>'), src.indexOf('// Отметки серий'));
  ok(/pull\(b\) - pull\(a\)/.test(body), 'добивка идёт по откату');
  ok(!/b\.entryValue\.pct - a\.entryValue\.pct/.test(body),
    'а не по баллу — он ровный от 1 до 100 и наверх поднимал наугад');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
