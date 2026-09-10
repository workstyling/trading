// Закрытое и незакрытое стоят рядом.
//
// Заголовок показывал только реализованное — записи, сохранённые кнопкой
// «Save Profit». Но убыток не реализуется: он остаётся в кошельке и ждёт
// возврата. На экране стояло +$1202, пока в открытых позициях лежало −$1022,
// и оба числа были верными по отдельности и лживыми вместе.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

console.log('\nДесктоп');
{
  const h = read('public/index.html');
  ok(/id="profitOpen"/.test(h), 'место под строку есть');
  ok(/data-live="1"/.test(h.slice(h.indexOf('id="profitOpen"') - 60, h.indexOf('id="profitOpen"') + 60)),
    'и оно помечено живым — иначе перерисовка списка его моргала бы');

  const i = h.indexOf('function paintOpenUnrealized(realized) {');
  const src = h.slice(i, h.indexOf('\n    function updateProfitPanel', i));
  const ctx = {
    _openUnrealized: null,
    setLiveHtml: (el, html) => { ctx._out = html; },
    document: { getElementById: () => ({}) },
    Math, String, Number,
  };
  vm.createContext(ctx);
  vm.runInContext(src + ';this.paint = paintOpenUnrealized;', ctx);

  ctx._out = null;
  ctx.paint(1202.49);
  ok(ctx._out === '', 'без открытых позиций строки нет, а не «$0.00»');

  ctx._openUnrealized = { n: 8, priced: 8, unrealized: -1022.25 };
  ctx.paint(1202.49);
  const t = ctx._out.replace(/<[^>]+>/g, '');
  ok(/в открытых −\$1,022\.25/.test(t), 'незакрытое показано со знаком', t);
  ok(/вместе \+\$180\.24/.test(t), 'и итог с ним посчитан', t);
  ok(/#ff6b6b/.test(ctx._out), 'минус красным');

  ctx._openUnrealized = { n: 3, unrealized: 40 };
  ctx.paint(-100);
  const t2 = ctx._out.replace(/<[^>]+>/g, '');
  ok(/в открытых \+\$40\.00/.test(t2) && /вместе −\$60\.00/.test(t2), 'знаки в обе стороны', t2);

  // Журнал строит позиции из окна последних ордеров: продажа за краем окна
  // оставляет позицию «открытой» навсегда. PUMP на $1163 и CRO на $1197
  // числились открытыми, хотя в кошельке их нет — и входили в это число.
  ctx._openUnrealized = { n: 8, counted: 5, unrealized: -700,
    unconfirmed: [{ coin: 'PUMP', why: 'нет в кошельке', cost: 1163 }] };
  ctx.paint(1000);
  const t3 = ctx._out.replace(/<[^>]+>/g, '');
  ok(/\(5 из 8\)/.test(t3), 'видно, сколько позиций вошло в число', t3);
  ok(/PUMP — нет в кошельке/.test(ctx._out), 'и кого кошелёк не подтвердил');
  ok(/#f5843a/.test(ctx._out), 'расхождение помечено цветом');
  ctx._openUnrealized = { n: 5, counted: 5, unrealized: -700, unconfirmed: [] };
  ctx.paint(1000);
  ok(!/из 5/.test(ctx._out.replace(/<[^>]+>/g, '')), 'когда всё сходится — лишней приписки нет');

  // Источники разные, и молчать об этом нельзя
  ok(/Источники разные/.test(src), 'в подсказке сказано, что источники разные');
  ok(/Убыток не реализуется сам/.test(src), 'и почему без этой строки его не видно');
  // Цена ходит — значит и число должно
  ok(/setInterval\(loadOpenUnrealized, 60000\)/.test(h), 'обновляется само раз в минуту');
  ok(/paintOpenUnrealized\(total\)/.test(h), 'и перерисовывается вместе с итогом');
}

console.log('\nСервер сверяет открытые позиции с кошельком');
{
  const src = read('server.js');
  const ep = src.slice(src.indexOf("app.get('/api/journal'"), src.indexOf("app.delete('/api/journal/closed'"));
  ok(/fetchAccountBalances\(\)/.test(ep), 'баланс запрашивается');
  ok(/p\.wallet = 'нет в кошельке'/.test(ep), 'монета не в кошельке — позиция помечена');
  ok(/Math\.abs\(real - p\.totalSize\) \/ p\.totalSize > 0\.05/.test(ep), 'и расхождение по размеру тоже');
  ok(/counted = priced\.filter\(p => p\.wallet == null \|\| p\.wallet === 'ok'\)/.test(ep),
    'в сумму идут только подтверждённые');
  // Без баланса сверять нечем — тогда считаем как раньше, а не выкидываем всё
  ok(/p\.wallet = null; continue;/.test(ep), 'без баланса позиции не выбрасываются');
  ok(/unconfirmed:/.test(ep), 'и список неподтверждённых уходит наружу');

  const d = read('public/index.html');
  ok(/Кошелёк не подтверждает эту позицию/.test(d), 'в таблице журнала такие строки помечены');
  ok(/opacity:0\.55/.test(d), 'и приглушены');
}

console.log('\nМобильная');
{
  const m = read('public/mobile/index.html');
  ok(/id="profitOpenM"/.test(m), 'место под строку есть');
  const i = m.indexOf('function paintOpenUnrealizedM() {');
  const src = m.slice(i, m.indexOf('\n    async function loadProfit', i));
  const ctx = { _openUnrealizedM: null, _realizedTotal: 0, _el: { innerHTML: null }, Math, String };
  ctx.document = { getElementById: () => ctx._el };
  vm.createContext(ctx);
  vm.runInContext(src + ';this.paint = paintOpenUnrealizedM;', ctx);

  ctx.paint();
  ok(ctx._el.innerHTML === '', 'без открытых позиций строки нет');
  ctx._openUnrealizedM = { n: 8, unrealized: -1022.25 };
  ctx._realizedTotal = 1202.49;
  ctx.paint();
  const t = ctx._el.innerHTML.replace(/<[^>]+>/g, '');
  ok(/в открытых −\$1022\.25/.test(t), 'незакрытое показано', t);
  ok(/вместе \+\$180\.24/.test(t), 'и итог с ним', t);
  ok(/setInterval\(loadOpenUnrealizedM, 60000\)/.test(m), 'обновляется само');

  // Обе вёрстки берут одно и то же число из одного места
  ok(/stats\.openTotal/.test(m) && /stats\.openTotal/.test(read('public/index.html')),
    'и там и там источник один — журнал сделок');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
