// Пять ошибок из внешней проверки 50fa56f. Каждая проверяется с той стороны,
// с какой её нашли: не «код такой», а «поведение такое».
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');

console.log('\n1. Неполная история не должна превращаться в вероятность');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.match(/function recoveryOdds[\s\S]*?\n}/)[0] + '\n' +
    src.match(/function runupOdds[\s\S]*?\n}/)[0], ctx);
  // Number(null) === 0, а не NaN: без явной проверки отказ становился
  // «падением 0%» и панель показывала 56% там, где оценки нет.
  for (const v of [null, undefined, '']) {
    ok(ctx.recoveryOdds(v) === null, 'recoveryOdds(' + JSON.stringify(v) + ') отказывает, а не даёт 56%');
    ok(ctx.runupOdds(v) === null, 'runupOdds(' + JSON.stringify(v) + ') отказывает');
  }
  ok(ctx.recoveryOdds(0) && ctx.recoveryOdds(0).hour === 56, 'настоящий ноль по-прежнему считается');
  // Сетка стала двумерной: к глубине за сутки добавился откат, и внутри
  // каждой полосы глубины он даёт ещё 11-18 пунктов. Прежние 77% — число из
  // одномерной таблицы, которой больше нет.
  ok(ctx.recoveryOdds(12).hour === 78, 'глубокое падение считается', 'дало ' + ctx.recoveryOdds(12).hour);
  ok(ctx.recoveryOdds(12, 2).hour === 89, 'и глубокое падение с откатом — выше', 'дало ' + ctx.recoveryOdds(12, 2).hour);
  ok(ctx.recoveryOdds(12, 2).deep === true, 'откат от 1.5% помечен как взятый порог');
}

console.log('\n2. Сторож покрытия суток отдаёт отказ, а не заниженное падение');
{
  const m = src.match(/const dayOk = ([^;]+);/);
  ok(!!m, 'сторож на месте', m && m[1]);
  ok(/dayCoverH >= 20/.test(src) && /winDay\.length >= 30/.test(src), 'требует и часов, и свечей');
  ok(/const highDay = dayOk \?/.test(src), 'без покрытия суточный максимум не считается');
}

console.log('\n3. Учёт времени в журнале');
{
  const at = src.match(/const at = \(min\) => \{[\s\S]*?\n      \};/)[0];
  // Метка свечи — её начало; закрытие приходится на минуту позже.
  ok(/const want = t\.at \+ \(min - 1\) \* 60_000;/.test(at),
    'отметка берёт свечу, которая на нужной минуте ЗАКРЫВАЕТСЯ');
  ok(/if \(mins \+ 1 > 60\) break;/.test(src), 'часовая отсечка по концу свечи');
  ok(/t\.hit3d = t\.hit60 != null/.test(src),
    'трёхдневный не теряет возврат, подтверждённый за час');
}

console.log('\n4. Диагностика не закрепляет неполный расчёт');
{
  ok(/out\.v2 = MARKOUT_HORIZONS\.every\(m => out\['h' \+ m\] != null\);/.test(src),
    'окончательным считается только полный расчёт');
  ok(/\(m\.tries \|\| 0\) < 4/.test(src), 'неполный пересчитывается, но не бесконечно');
  ok(/t\.openedAt <= ready/.test(src), 'и не считается раньше, чем горизонт наступил');
}

console.log('\n5. Telegram описывает действующие параметры');
{
  const MICRO_EXECUTION = { targetPct: 2.0, slPct: 2.0, maxHoldMin: 480 };
  const ctx = { MICRO_EXECUTION };
  vm.createContext(ctx);
  vm.runInContext(src.match(/function microScalpTerms[\s\S]*?\n}/)[0], ctx);
  ok(ctx.microScalpTerms() === 'цель +2%, стоп −2%, до 8 ч', 'подпись собрана из настроек', ctx.microScalpTerms());
  ok(!/цель \+1%, стоп −1%, максимум 60 минут/.test(src), 'набранной руками подписи не осталось');
  // Меняем настройки — подпись обязана поехать за ними
  ctx.MICRO_EXECUTION = { targetPct: 1.5, slPct: 3, maxHoldMin: 45 };
  ok(ctx.microScalpTerms() === 'цель +1.5%, стоп −3%, максимум 45 мин',
    'и следует за ними при изменении', ctx.microScalpTerms());
}

console.log('\n6. Интерфейс не рисует отсутствие как плюс');
for (const path of ['public/index.html', 'public/mobile/index.html']) {
  const h = fs.readFileSync(path, 'utf8');
  const num = h.match(/const num = v => v == null \? '—' : \(v >= 0 \? '\+' : ''\) \+ v \+ '%';/);
  ok(!!num, path.replace('public/', '') + ': пустое среднее рисуется прочерком');
  ok(/const col = v => v == null \? 'var\(--t2\)'/.test(h),
    path.replace('public/', '') + ': и не красится зелёным');
  ok(!/но убыток сокращает\./.test(h),
    path.replace('public/', '') + ': подсказка не утверждает пользу порога как доказанную');
  ok(/подтверждения пока нет/.test(h),
    path.replace('public/', '') + ': а говорит, что проверка идёт');
}

console.log('\n7. Отсутствие числа не выглядит как положительное число');
{
  const h = fs.readFileSync('public/index.html', 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(h.match(/function pctSigned[\s\S]*?\n    }/)[0], ctx);
  for (const v of [null, undefined, NaN, '']) {
    ok(ctx.pctSigned(v) === '\u2014', 'pctSigned(' + JSON.stringify(v) + ') = \u043f\u0440\u043e\u0447\u0435\u0440\u043a', ctx.pctSigned(v));
  }
  ok(ctx.pctSigned(0) === '+0%', '\u043d\u0430\u0441\u0442\u043e\u044f\u0449\u0438\u0439 \u043d\u043e\u043b\u044c \u043f\u0435\u0447\u0430\u0442\u0430\u0435\u0442\u0441\u044f \u0441\u043e \u0437\u043d\u0430\u043a\u043e\u043c');
  ok(ctx.pctSigned(-1.5) === '-1.5%', '\u043c\u0438\u043d\u0443\u0441 \u043e\u0441\u0442\u0430\u0451\u0442\u0441\u044f \u043c\u0438\u043d\u0443\u0441\u043e\u043c');
  ok(ctx.pctSigned(2, ' \u043f.\u043f.') === '+2 \u043f.\u043f.', '\u0435\u0434\u0438\u043d\u0438\u0446\u0430 \u0438\u0437\u043c\u0435\u0440\u0435\u043d\u0438\u044f \u043f\u043e\u0434\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442\u0441\u044f');

  // \u0416\u0438\u0432\u043e\u0439 \u0441\u043b\u0443\u0447\u0430\u0439: \u0443 \u043d\u043e\u0432\u043e\u0439 \u043a\u043e\u0433\u043e\u0440\u0442\u044b \u043d\u0435\u0442 \u0437\u0430\u043a\u0440\u044b\u0442\u044b\u0445 \u0441\u0434\u0435\u043b\u043e\u043a, \u0438 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0430
  // \u00ab\u041d\u0430 \u0441\u0434\u0435\u043b\u043a\u0443\u00bb \u0440\u0438\u0441\u043e\u0432\u0430\u043b\u0430 \u00ab+null%\u00bb \u0437\u0435\u043b\u0451\u043d\u044b\u043c.
  ok(/pctSigned\(st\.avgPct\)/.test(h), '\u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0430 \u00ab\u041d\u0430 \u0441\u0434\u0435\u043b\u043a\u0443\u00bb \u0438\u0434\u0451\u0442 \u0447\u0435\u0440\u0435\u0437 \u043f\u043e\u043c\u043e\u0449\u043d\u0438\u043a\u0430');
  ok(!/st\.avgPct >= 0/.test(h), '\u043f\u0440\u0435\u0436\u043d\u0435\u0439 \u0441\u043a\u043b\u0435\u0439\u043a\u0438 \u043d\u0435 \u043e\u0441\u0442\u0430\u043b\u043e\u0441\u044c');
  for (const path of ['public/index.html', 'public/mobile/index.html']) {
    const x = fs.readFileSync(path, 'utf8');
    ok(/const sgn = v => v == null/.test(x) && !/const sgn = v => \(v >= 0/.test(x),
      path.replace('public/', '') + ': индикатор рынка защищён на месте');
  }
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
