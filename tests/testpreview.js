// У поля Limit price не было результата вовсе, хотя цена в нём уже стоит.
// Рядом при этом лежали четыре числа от других цен, и глаз брал ближайшее —
// строку стоп-лимита. А это ответ на другой вопрос: там тейкер, потому что
// сработавший стоп забирает встречную заявку, а простая лимитка стоит в
// стакане и платит мейкера.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

const el = { innerHTML: '', title: '' };
const input = { value: '' };
const ctx = {
  document: { getElementById: id => id.startsWith('limitSellPnl_') ? el : id.startsWith('limitSellPrice_') ? input : null },
  // Живые места пишутся через setLiveHtml: он не пересобирает узлы, если
  // каркас тот же. В песочнице подменяем простым присваиванием — проверяем
  // содержимое, а не способ записи.
  setLiveHtml: (e, html) => { e.innerHTML = html; },
  getFeeLimit: () => 0.00075,
  getFeeMarket: () => 0.0015,
  parseFloat, String, Number, Math, console,
};
vm.createContext(ctx);
{
  const i = h.indexOf('function previewLimitSell');
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx);
}
const txt = () => el.innerHTML.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

console.log('\nСчитает по цене из поля');
{
  input.value = '0.01777';
  ctx.previewLimitSell('CP', '67935', 1212.05);
  // 67935 * 0.01777 * (1 - 0.00075) - 1212.05 = -5.75
  ok(/−\$5\.75 если постоит/.test(txt()), 'мейкер посчитан по цене из поля', txt());
  // 67935 * 0.01777 * (1 - 0.0015) - 1212.05 = -6.66 — ровно то, что показывает
  // строка стоп-лимита, и теперь видно, что это другой случай
  ok(/−\$6\.66 если заберёт сразу/.test(txt()), 'тейкер тоже назван, и он совпал со стоп-лимитом');
  ok(txt().indexOf('если постоит') < txt().indexOf('если заберёт'),
    'сперва то, что будет при обычной лимитке');
}

console.log('\nПустое и мусор');
for (const v of ['', '   ', 'abc', '0', '-1']) {
  input.value = v;
  ctx.previewLimitSell('CP', '67935', 1212.05);
  ok(txt() === '', 'на «' + v + '» ничего не рисуется, а не NaN', txt());
}
input.value = '0,01777';
ctx.previewLimitSell('CP', '67935', 1212.05);
ok(/\$/.test(txt()), 'запятая как разделитель понимается', txt());

console.log('\nБез позиции считать нечего');
input.value = '0.01777';
ctx.previewLimitSell('CP', '0', 1212.05);
ok(txt() === '', 'без объёма пусто');
ctx.previewLimitSell('CP', '67935', 0);
ok(txt() === '', 'без потраченного тоже');

console.log('\nПрибыль показывается зелёной');
input.value = '0.02';
ctx.previewLimitSell('CP', '67935', 1212.05);
ok(/\+\$/.test(txt()) && /var\(--green\)/.test(el.innerHTML), 'плюс и зелёный цвет', txt());

console.log('\nСвязи в разметке');
ok(/id="limitSellPnl_\$\{coin\}"/.test(h), 'место под результат есть');
ok(/oninput="previewLimitSell\('\$\{coin\}','\$\{totalFilled\}',\$\{totalUSD\}\)"/.test(h),
  'ввод пересчитывает');
ok(/pi\.value = String\(px\.limit\); previewLimitSell\(coin, size, cost\);/.test(h),
  'подстановка цены шагами тоже пересчитывает');
ok(/container\.querySelectorAll\('\[id\^="limitSellPnl_"\]'\)/.test(h),
  'после перерисовки результат восстанавливается, а не ждёт ввода');
ok(/комиссию мейкера/.test(h), 'подсказка объясняет, откуда две цифры');

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
