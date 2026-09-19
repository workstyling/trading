// Предрегистрированную проверку нельзя «дождаться».
//
// Пороги зашиты до прихода данных — в этом весь смысл. Но состояние
// пересчитывалось на каждом запросе по всей накопленной выборке, и значимость
// проверялась ПЕРЕД точкой сдачи. Значит выборку можно было копить дальше и
// ждать, пока разница случайно перевалит за две ошибки.
//
// Так и стояло в живом журнале: на 139 исходах при пороге сдачи 120 разница
// была +0.398 ±0.28 — 1.4 ошибки и колеблется. Ещё сотня наблюдений, и знак
// однажды сошёлся бы «значимо лучше контроля» просто по случайности. Это та
// самая ошибка, ради которой пороги и записывались заранее, только сделанная
// самим кодом.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const J = require('../src/recovery/journal');

// Сделки, дающие нужное число исходов и часов. Контрольные помечены cv:2 —
// сравнение берёт только проверенный контроль. Шум обязателен: без разброса
// ошибка разности выходит нулевой, и «значимо» становится всё подряд.
const HOUR = 3600000, BASE = Date.now() - 5 * 86400000;
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const trades = (n, m60, noise, control = false) => {
  seed = control ? 7 : 3;
  return Array.from({ length: n }, (_, i) => ({
    outcomeVersion: 4, m60: m60 + rnd() * noise, coin: 'C' + (i % 15),
    ...(control ? { cv: 2 } : {}), at: BASE - (i % 40) * HOUR,
  }));
};

console.log('\nДо порогов — ждём');
{
  const d = J.assessTake(trades(10, 1, 1), trades(10, 0, 1, true));
  ok(d.state === 'ждём', 'мало исходов — решения нет', d.state);
  ok(!d.seal, 'и печатать нечего');
}

console.log('\nРешение печатается, когда наступило');
{
  // Точка сдачи: исходов много, разница в пределах погрешности
  const d = J.assessTake(trades(200, 0.10, 6), trades(200, 0.05, 6, true));
  ok(d.haveN >= d.giveUpN, 'исходов больше порога сдачи', d.haveN + '/' + d.giveUpN);
  ok(d.state === 'преимущество не подтверждено', 'вердикт — сдача', d.state);
  ok(d.seal && d.seal.state === d.state && d.seal.n === d.haveN,
    'и он отдан каллеру на сохранение', d.seal && JSON.stringify(d.seal));
}

console.log('\nПечать старше любых поздних наблюдений');
{
  const sealed = { state: 'преимущество не подтверждено', at: 1, n: 139, diff: 0.398, se: 0.28 };
  // Новая выборка «стала значимой» — вердикт не меняется
  const later = J.assessTake(trades(400, 5, 0.6), trades(400, 0, 0.6, true), sealed);
  ok(later.state === 'преимущество не подтверждено',
    'позднейшая значимость вердикт не отменяет', later.state);
  ok(later.stateNow && later.stateNow !== later.state,
    'но пересчитанное состояние видно отдельно, а не спрятано', later.stateNow);
  ok(later.sealed && later.sealed.n === 139, 'видно, на скольких исходах решали');
  ok(/больше не пересматривается/.test(later.why), 'и сказано почему', later.why.slice(0, 80));
  ok(!later.seal, 'повторно печатать нечего');
  // Числа продолжают считаться: печать закрывает слово, а не измерение
  ok(later.haveN >= 139, 'наблюдения продолжают накапливаться', String(later.haveN));
  ok(later.comparison && later.comparison.n === later.haveN, 'и сравнение по ним считается');
}

console.log('\nРанняя значимость — законный ответ, а не сдача');
{
  const d = J.assessTake(trades(60, 3, 0.6), trades(60, 0, 0.6, true));
  ok(d.haveN < d.giveUpN, 'исходов меньше порога сдачи', d.haveN + '/' + d.giveUpN);
  ok(d.state === 'лучше контроля' || d.state === 'хуже контроля',
    'значимость до сдачи даёт содержательный вердикт', d.state);
  ok(d.seal && d.seal.state === d.state, 'он тоже печатается — пересматривать его тоже нельзя');
}

console.log('\nПорядок проверок');
{
  const src = fs.readFileSync('src/recovery/journal.js', 'utf8');
  ok(/if \(sealed && sealed\.state\)/.test(src), 'печать проверяется отдельно от расчёта');
  ok(/out\.stateNow = out\.state;/.test(src), 'пересчитанное состояние не затирается молча');
  ok(/out\.seal = \{ state: out\.state/.test(src), 'терминальное состояние отдаётся на сохранение');
}

console.log('\nСервер хранит печать и привязывает её к правилу');
{
  const srv = fs.readFileSync('server.js', 'utf8');
  ok(/decision: entryDecision\(take, ctrl\)/.test(srv), 'решение идёт через хранилище печатей');
  ok(/function entryDecision\(take, ctrl\)/.test(srv), 'и оно есть');
  const fn = srv.slice(srv.indexOf('function entryDecision'), srv.indexOf('function entryDecision') + 1400);
  ok(/entryPaper\.decisions/.test(fn), 'печати лежат рядом со сделками — переживают перезапуск');
  ok(/seals\[ENTRY_RULE\]/.test(fn), 'ключ — правило входа: смена правила начинает новую проверку');
  ok(/if \(out\.seal && !seals\[ENTRY_RULE\]\)/.test(fn), 'вторично не перепечатывается');
  ok(/saveEntryPaper\(\)/.test(fn), 'и записывается на диск сразу');
  ok(/console\.log\('\[entry-paper\] решение по правилу/.test(fn), 'момент решения виден в логе сервера');
}

console.log('\nЖивые числа: почему это было не теоретической дырой');
{
  // На 139 исходах при пороге 120 разница 1.4 ошибки. Две ошибки — вопрос
  // времени, а не истины: на всех данных та же разница отрицательная.
  const n = 139, diff = 0.398, se = 0.28;
  ok(n > 120, 'точка сдачи пройдена', n + ' > 120');
  ok(Math.abs(diff) < 2 * se, 'но значимости нет', (Math.abs(diff) / se).toFixed(1) + ' ошибки');
  ok(-0.109 < 0, 'а на всей выборке разница вовсе отрицательная', '-0.109 ±0.143');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
