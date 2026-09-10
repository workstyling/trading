// Ордер, исполненный на 48%, показывал DONE 100% — и рядом живую кнопку
// Cancel. Экран противоречил сам себе.
//
// Причина: заказанный объём читался только у двух видов ордеров. У
// стоп-лимита ключ конфигурации третий, размер не находился, подставлялся
// ИСПОЛНЕННЫЙ — и доля выходила ровно единицей всегда.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };

for (const [label, path] of [['index.html', 'public/index.html'], ['mobile/index.html', 'public/mobile/index.html']]) {
  console.log('\n' + label);
  const h = fs.readFileSync(path, 'utf8');
  const ctx = { Object, String, parseFloat, console };
  vm.createContext(ctx);
  const i = h.indexOf('function orderBaseSize');
  ok(i > 0, 'помощник есть');
  if (i < 0) continue;
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx);
  const f = ctx.orderBaseSize;

  // Настоящий ордер по CRO: заказано 41421.9, исполнено 19905.7
  const stop = { order_configuration: { stop_limit_stop_limit_gtc: { base_size: '41421.9', limit_price: '0.06031' } } };
  ok(f(stop) === '41421.9', 'стоп-лимит: размер найден', String(f(stop)));
  const filled = 19905.7;
  const pct = (filled / parseFloat(f(stop)) * 100).toFixed(0);
  ok(pct === '48', 'доля исполнения выходит 48%, а не 100%', pct + '%');

  ok(f({ order_configuration: { limit_limit_gtc: { base_size: '100' } } }) === '100', 'обычная лимитка');
  ok(f({ order_configuration: { stop_limit_stop_limit_gtd: { base_size: '7' } } }) === '7', 'и стоп-лимит со сроком');
  // Рыночная покупка на сумму: base_size нет вовсе, и это не ошибка
  ok(f({ order_configuration: { market_market_ioc: { quote_size: '2491.03' } } }) === null,
    'у покупки на сумму размера нет — вернётся null, дальше возьмётся исполненное');
  ok(f({}) === null, 'пустой ордер не роняет расчёт');
  ok(f(null) === null, 'и отсутствующий тоже');
  ok(f({ order_configuration: { limit_limit_gtc: { base_size: '0' } } }) === null, 'нулевой размер за размер не считается');
}

console.log('\nПрежних узких чтений не осталось');
for (const [label, path] of [['index.html', 'public/index.html'], ['mobile/index.html', 'public/mobile/index.html']]) {
  const h = fs.readFileSync(path, 'utf8');
  ok(!/order_configuration\?\.limit_limit_gtc\?\.base_size/.test(h),
    label + ': размер больше не берётся только у лимитки');
}

console.log('\nDONE считается от заказанного');
{
  const h = fs.readFileSync('public/index.html', 'utf8');
  ok(/const size = orderBaseSize\(o\) \|\| o\.filled_size \|\| '-';/.test(h),
    'колонка Size берёт заказанное, а исполненное — только если заказанного нет');
  const body = h.slice(h.indexOf("const size = orderBaseSize(o) || o.filled_size || '-';"));
  ok(/parseFloat\(filled\) \/ parseFloat\(size\)/.test(body.slice(0, 900)), 'доля считается от него же');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
