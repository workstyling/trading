// Панель отбора должна знать, что уже лежит в кошельке.
//
// RAY стоял в таблице с пометкой «брать», когда его уже было 36% портфеля, а
// свободных денег оставалось тридцать долларов. Совет докупить то, чего и так
// слишком много, — это не подсказка, а ловушка.
//
// И главное: чтобы её убрать, не нужно ничего предсказывать. Выбор монеты
// преимущества не даёт — это измерено трижды. А размер позиции даёт разброс
// исхода целиком и полностью в руках человека.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

const HOLD = [
  { currency: 'RAY', usdValue: 3012 },
  { currency: 'ENA', usdValue: 2020 },
  { currency: 'ASTER', usdValue: 394 },
  { currency: 'USD', usdValue: 31 },
];

for (const [name, file, sfx] of [['десктоп', 'public/index.html', ''], ['мобильная', 'public/mobile/index.html', 'M']]) {
  console.log('\n' + name);
  const src = read(file);
  const from = src.indexOf('const BOOK_MAX_COIN_PCT' + (sfx ? '_M' : '') + ' =');
  const to = src.indexOf('function paintBookShares' + sfx);
  ok(from > 0 && to > from, 'блок про кошелёк найден');
  if (!(from > 0 && to > from)) continue;

  const ctx = { Math, Number, document: { querySelectorAll: () => [] }, console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(from, to) +
    ';this.setBook = setBookFromHoldings' + sfx +
    '; this.share = bookShare' + sfx +
    '; this.warn = bookWarning' + sfx + ';', ctx);
  ctx.setBook(HOLD);

  // Доли считаются от ПОЗИЦИЙ, а не от всего счёта: доллары не позиция
  ok(ctx.share('RAY') === 55.5, 'доля RAY посчитана от позиций', String(ctx.share('RAY')));
  ok(ctx.share('ASTER') === 7.3, 'и мелкой позиции тоже', String(ctx.share('ASTER')));
  ok(ctx.share('BTC') === null, 'монеты не из кошелька — без доли');

  console.log('  — предупреждение о размере');
  // Докупить то, чего и так больше половины
  const w1 = ctx.warn('RAY', 500).replace(/<[^>]+>/g, '');
  ok(/RAY/.test(w1) && /займёт 5\d\.\d% портфеля/.test(w1),
    'на перегруженную монету предупреждает', w1.slice(0, 90));
  ok(/Размер позиции/.test(w1), 'и названо, о чём речь');

  // Маленькая покупка мелкой монеты при живом кошельке — молчим
  // Десять равных позиций и живой запас денег: докупка на сотню ничего не
  // нарушает — ни доли монеты, ни остатка свободных
  const rich = [];
  for (let i = 0; i < 10; i++) rich.push({ currency: 'C' + i, usdValue: 1000 });
  rich.push({ currency: 'USD', usdValue: 2000 });
  ctx.setBook(rich);
  ok(ctx.warn('C0', 100) === '', 'когда всё в порядке — не мешаем', ctx.warn('C0', 100).replace(/<[^>]+>/g, ''));

  // Пустой кошелёк: предупреждаем про остаток денег
  ctx.setBook(HOLD);
  const w2 = ctx.warn('ASTER', 20);
  ok(/Свободных останется/.test(w2), 'мало свободных — предупреждает и об этом', w2.replace(/<[^>]+>/g, '').slice(0, 90));

  // Без данных о кошельке молчим, а не выдумываем
  ctx.setBook([]);
  ok(ctx.warn('RAY', 1000) === '', 'без кошелька ничего не утверждаем');

  console.log('  — доля видна в строке таблицы');
  ok(/data-bookshare="' \+ x\.coin \+ '"/.test(src), 'место под долю есть в строке монеты');
  ok(/paintBookShares' + sfx + '\(\)/.test(src.replace(/\s+/g, ' ')) || src.includes('paintBookShares' + sfx + '()'),
    'и оно заполняется после отрисовки');
  ok(src.includes('setBookFromHoldings' + sfx + '(holdings)'), 'кошелёк питает эти доли');
  // Предупреждение обязано стоять в окне подтверждения покупки
  ok(src.includes('bookWarning' + sfx + '(coin, ' + (sfx ? 'usd' : 'quoteSize') + ')'),
    'предупреждение показано перед покупкой по рынку');
}

console.log('\nПороги названы числами и одинаковы в обеих вёрстках');
{
  const d = read('public/index.html'), m = read('public/mobile/index.html');
  ok(/const BOOK_MAX_COIN_PCT = 20/.test(d) && /const BOOK_MAX_COIN_PCT_M = 20/.test(m),
    'потолок на монету — 20% и там и там');
  ok(/const BOOK_MIN_CASH_PCT = 15/.test(d) && /const BOOK_MIN_CASH_PCT_M = 15/.test(m),
    'запас свободных — 15% и там и там');
  // Это предупреждение, а не запрет: чужими деньгами распоряжаться не нам
  ok(/предупреждение, а не запрет/.test(d), 'и сказано, что это не запрет');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
