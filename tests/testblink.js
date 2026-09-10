// Строка стоп-лимита мигала: части подписи то появлялись, то исчезали.
//
// Правку на месте делает setLiveHtml, и она возможна, только когда набор
// узлов совпал. Пока «чистыми» и «ниже бида» были условными, первая отрисовка
// давала одну разметку, а следующий стакан — другую: строка не правилась, а
// пересобиралась целиком по нескольку раз в минуту.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

const grab = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('не найдено: ' + name);
  const end = src.indexOf('\n    }\n', i);
  if (end < 0) throw new Error('не нашёл конец: ' + name);
  return src.slice(i, end + 6);
};
// Последовательность тегов — то самое, что сравнивает sameSkeleton
const skeleton = (html) => (html.match(/<[a-z]+/g) || []).join(',');
const ZW = '​';

const cases = [
  ['всё известно', [1.5, 1.4, '10', '12', false, false, 40, 1.55]],
  ['бид ещё не известен (первая отрисовка)', [1.5, 1.4, '10', '12', false, false, 0, 0]],
  ['объём не передан — прибыль не считается', [1.5, 1.4, null, null, false, false, 40, 1.55]],
  ['прибыль в плюсе', [1.5, 1.4, '10', '1', false, false, 40, 1.55]],
  ['стакан короче запроса', [1.5, 1.4, '10', '12', true, false, 3, 1.55]],
  ['до дна дошёл только лимит', [1.5, 1.4, '10', '12', false, true, 3, 1.55]],
];

for (const [file, fn, stubs] of [
  ['public/index.html', 'sellStepInfoHtml', { fmtPrice: (x) => String(x), getFeeMarket: () => 0.0015 }],
  ['public/mobile/index.html', 'sellStepInfoHtmlM', { fmt: (x) => String(x), tradingSettings: { marketFee: 0.25 } }],
]) {
  console.log('\n' + file);
  const src = read(file);
  const ctx = vm.createContext({ ...stubs });
  vm.runInContext(grab(src, fn), ctx);
  const f = ctx[fn];
  ok(typeof f === 'function', 'функция подписи нашлась');

  const base = skeleton(f(...cases[0][1]));
  for (const [name, args] of cases) {
    ok(skeleton(f(...args)) === base, 'набор узлов тот же: ' + name, skeleton(f(...args)));
  }
  // Пусто должно быть невидимым символом, а не отсутствующим узлом: в
  // исчезнувший узел текст потом не вернуть — он останется пустым навсегда.
  ok(f(...cases[1][1]).includes(ZW), 'пустое место занято невидимым символом');
  ok(!/ниже бида/.test(f(...cases[1][1])), 'без бида про бид не пишем');
  ok(/ниже бида на 3\.23%/.test(f(...cases[0][1])), 'с бидом расстояние посчитано');
  ok(/чистыми/.test(f(...cases[0][1])), 'прибыль на месте');
  ok(!/чистыми/.test(f(...cases[2][1])), 'без объёма слово «чистыми» не висит впустую');
}

console.log('\nПодпись помнит, из чего собрана');
for (const [file, get] of [
  ['public/index.html', 'function sellSteps(coin)'],
  ['public/mobile/index.html', 'function sellStepsM(coin)'],
]) {
  const src = read(file);
  const body = src.slice(src.indexOf(get), src.indexOf(get) + 900);
  ok(/ref: v\.ref == null \? 0 : \+v\.ref/.test(body), file + ': бид сохраняется');
  ok(/stuck: !!v\.stuck, short: !!v\.short/.test(body), file + ': упор в дно тоже');
  // Иначе первая отрисовка даст подпись без них, а стакан вернёт обратно
  ok(/_st\.stuck, _st\.short, _st\.levels, _st\.ref/.test(src), file + ': и первая отрисовка их берёт');
  ok(/ref: ladder\[1\]/.test(src), file + ': стакан их записывает');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
