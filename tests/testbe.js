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
  ok(/\/api\/check-fills/.test(body), 'после сделки просит проверить исполнения сейчас');
  ok(/loadBeWatches\(\)/.test(body), 'и сразу забирает состояние сторожей');
  ok(body.indexOf('/api/check-fills') < body.indexOf('loadBeWatches'),
    'сначала проверка, потом чтение — иначе прочитает старое');
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
