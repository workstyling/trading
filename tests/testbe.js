// Сторож безубытка включается сервером по факту исполнения, а кнопка на
// экране рисовалась из состояния, снятого раньше. Купил по рынку — сторож уже
// стоит, а кнопка до полуминуты показывает «выключено».
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');
const h = fs.readFileSync('public/index.html', 'utf8');

console.log('\nСервер умеет проверить исполнения по требованию');
ok(/app\.post\('\/api\/check-fills'/.test(src), 'эндпоинт есть');
// Кеш ордеров сделан ДО сделки: не обойти его — значит проверять нечего
ok(/await checkFilledOrders\(true\);[\s\S]{0,120}res\.json\(\{ success: true, watches: beWatches \}\)/.test(src),
  'он гоняет ту же проверку в обход кеша и отдаёт свежих сторожей');

console.log('\nКлиент спрашивает состояние сразу после сделки');
{
  const i = h.indexOf('function refreshAfterTrade');
  const body = h.slice(i, i + 900);
  ok(/beCatchUp\(\)/.test(body), 'после сделки состояние сторожей догоняется');

  // ОДНОГО ЗАПРОСА МАЛО.
  //
  // Ордер только что отправлен, биржа ещё не пометила его исполненным — и
  // первый же запрос возвращает «ничего не случилось». Сторож появляется
  // секунд через тридцать, а кнопка до этого показывает «выключено»:
  // выглядит так, будто оповещение не поставилось, и помогает только
  // перезагрузка страницы.
  const cu = h.slice(h.indexOf('const BE_CATCHUP_AT = ['), h.indexOf('async function loadBeWatches'));
  ok(/\[1500, 6000, 15000, 35000, 70000\]/.test(cu), 'заходов несколько, с растущими промежутками');
  ok(cu.indexOf('/api/check-fills') < cu.indexOf('loadBeWatches'),
    'сначала проверка, потом чтение — иначе прочитает старое');
  ok(/if \(Object\.keys\(_beWatches\)\.length !== before\) return;/.test(cu),
    'и прекращаются, как только сторож появился');
  ok(/clearTimeout\(_beCatchUpTimer\)/.test(cu), 'две сделки подряд не плодят параллельные опросы');

  // Обе вёрстки: однажды они разошлись, и на телефоне запроса не было вовсе
  const m = fs.readFileSync('public/mobile/index.html', 'utf8');
  ok(/beCatchUpM\(\)/.test(m), 'на телефоне то же самое');
  ok(/\[1500, 6000, 15000, 35000, 70000\]/.test(m), 'и с теми же промежутками');
}

console.log('\nПерерисовка списка не возвращает старое состояние');
ok(/beRefreshSoon\(\)/.test(h), 'после перерисовки состояние переспрашивается');
{
  const i = h.indexOf('function beRefreshSoon');
  const body = h.slice(i, i + 400);
  ok(/now - _beAfterOrders < 3000/.test(body), 'но не чаще раза в три секунды');
  ok(/loadBeWatches\(\)/.test(body), 'и делает это через общий загрузчик');
}
ok(/paintBeButtons\(\);/.test(h), 'загрузчик перерисовывает кнопки');

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
