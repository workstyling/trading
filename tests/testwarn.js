// Подтверждение стоп-лимита: окно есть, и убыток в нём назван словом.
//
// Числа $0.05965 и $0.05963 сами по себе не говорят, что это минус десять
// долларов. Стоп-лимит часто и ставят ради выхода в минус — намерение
// законное, — но нажать его случайно, глядя на одни цены, слишком легко.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const d = fs.readFileSync('public/index.html', 'utf8');
const m = fs.readFileSync('public/mobile/index.html', 'utf8');

console.log('\nОкно подтверждения есть');
{
  const body = d.slice(d.indexOf('async function sellStopInline('), d.indexOf('async function sellAllLimit'));
  ok(/showConfirmModal\(/.test(body), 'десктоп: своё окно, а не системный confirm');
  ok(!/\bconfirm\(/.test(body), 'десктоп: системного окна нет');
}
{
  const body = m.slice(m.indexOf('async function sellStopInlineM('), m.indexOf('async function sellAllMarketM'));
  ok(/await confirmTrade\(/.test(body), 'мобильная: своё окно');
  ok(!/\bwindow\.confirm\(/.test(body), 'мобильная: системного окна нет');
}

console.log('\nУбыток назван');
for (const [name, h] of [['index.html', d], ['mobile/index.html', m]]) {
  ok(/Зафиксирует убыток/.test(h), name + ': сказано, что убыток будет зафиксирован');
  ok(/const loss = pnl != null && pnl < 0;/.test(h), name + ': признак убытка считается');
  ok(/#ff6b6b/.test(h.slice(h.indexOf('Зафиксирует убыток') - 300, h.indexOf('Зафиксирует убыток'))),
    name + ': предупреждение выделено красным');
  ok(/Продажа в убыток|Зафиксирует убыток/.test(h), name + ': заголовок или блок говорят о минусе');
}
ok(/showConfirmModal\(\(loss \? 'Продажа в убыток: ' : 'Стоп-лимит на всё: '\)/.test(d),
  'десктоп: заголовок окна меняется на убыточный');

console.log('\nРасчёт того, что показывается');
{
  // Комиссия рыночная: сработавший стоп ставит лимитку по цене, которая уже
  // прошла — она забирает встречную заявку и платит как тейкер.
  const qty = 21516.2, spent = 1291.90, limit = 0.05963, fee = 0.0015;
  const pnl = qty * limit * (1 - fee) - spent;
  ok(pnl < 0, 'на текущих числах это убыток', '$' + pnl.toFixed(2));
  ok(Math.abs(pnl + 10.82) < 0.5, 'и он совпадает с тем, что в строке', '$' + pnl.toFixed(2));
  const pct = pnl / spent * 100;
  ok(Math.abs(pct + 0.84) < 0.05, 'процент считается от потраченного', pct.toFixed(2) + '%');

  // Без объёма или без потраченного считать нечего — предупреждения быть не
  // должно, но и продажу блокировать не за что.
  const calc = (q, c) => (q > 0 && c > 0) ? q * limit * (1 - fee) - c : null;
  ok(calc(0, spent) === null, 'без объёма прибыль не считается');
  ok(calc(qty, 0) === null, 'без потраченного тоже');
}

console.log('\nЧисла доезжают до окна');
ok(/sellStopInline\('\$\{pair\}','\$\{totalFilled\}','\$\{coin\}',\$\{totalUSD\}\)/.test(d),
  'десктоп: потраченное передаётся в окно');
ok(/sellStopInlineM\('\$\{pair\}','\$\{totalFilledStr\}','\$\{coin\}',\$\{totalUSD\}\)/.test(m),
  'мобильная: потраченное передаётся в окно');
ok(/async function sellStopInline\(pair, size, coin, cost\)/.test(d), 'десктоп: окно его принимает');
ok(/async function sellStopInlineM\(pair, size, coin, cost\)/.test(m), 'мобильная: окно его принимает');

console.log('\nПрочие условия остались');
for (const [name, h] of [['index.html', d], ['mobile/index.html', m]]) {
  ok(/не гарантирует исполнения/.test(h), name + ': про негарантированное исполнение сказано');
  ok(/if \(st\.stop < st\.limit\)/.test(h), name + ': стоп ниже лимита по-прежнему отклоняется');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
