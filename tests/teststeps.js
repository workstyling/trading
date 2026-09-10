// Строка настроек продажи: расположение, размер, прибыль и кнопки шага.
// Саму модель глубин проверяет testdepth.js — здесь только то, что видно.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

console.log('\nПорядок и место');
{
  const iStop = h.indexOf('sellStepStop_${coin}');
  const iAsk = h.indexOf('sellStepAsk_${coin}');
  ok(iStop > 0 && iAsk > 0, 'оба поля на месте');
  ok(iStop < iAsk, 'стоп идёт первым, лимит вторым');
  // Своя строка: в общей поля жались к краю среди кнопок продажи
  const iRow = h.lastIndexOf('margin-top:7px', iStop);
  ok(iRow > 0, 'управление вынесено на отдельную строку');
  ok(h.lastIndexOf('Sell Limit</button>', iStop) < iRow, 'лимитная цена осталась строкой выше');
  ok(h.lastIndexOf('limitSellPrice_${coin}', iStop) < iRow, 'и поле цены тоже выше');
}

console.log('\nРазмер');
ok(/\.step-inp\s*\{[^}]*width:\s*46px/.test(h), 'поле широкое');
ok(/\.step-inp\s*\{[^}]*font-size:\s*13px/.test(h), 'цифры крупные');
ok(/\.step-btn\s*\{[^}]*width:\s*26px/.test(h), 'кнопки крупные');
ok(/class="step-group"/.test(h), 'каждая пара обведена в свою группу');
// Родные стрелки занимали место справа, из-за чего число съезжало влево от
// центра, и дублировали кнопки, которые уже стоят по бокам.
ok(/\.step-inp::-webkit-inner-spin-button/.test(h) && /-webkit-appearance: none/.test(h),
  'родные стрелки убраны в webkit');
ok(/\.step-inp\s*\{[^}]*appearance: textfield/.test(h), 'и в остальных движках');
ok(/\.step-inp\s*\{[^}]*text-align: center/.test(h), 'число стоит по центру поля');

console.log('\nКнопки шага');
{
  // Кнопка дёргает поле напрямую и легко обходит min/max разметки, если о ней
  // не подумать. Правило применяется в пересчёте, поэтому здесь проверяем, что
  // кнопка именно его и зовёт, а не правит значение сама.
  const el = { value: '-1' };
  let called = null;
  const ctx = {
    document: { getElementById: () => el },
    recalcSellSteps: (...a) => { called = a; },
    Math, parseInt, console,
  };
  vm.createContext(ctx);
  const i = h.indexOf('function bumpSellStep');
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx);

  ctx.bumpSellStep('AAA', 'AAA-USD', 'stop', -1, '10', 100);
  ok(el.value === -2, 'минус уводит глубже', String(el.value));
  ctx.bumpSellStep('AAA', 'AAA-USD', 'stop', 1, '10', 100);
  ok(el.value === -1, 'плюс поднимает ближе к лучшему ask');
  ok(called && called[0] === 'AAA' && called[2] === '10' && called[3] === 100,
    'объём и потраченное доезжают до пересчёта', JSON.stringify(called));
  el.value = 'мусор';
  ctx.bumpSellStep('AAA', 'AAA-USD', 'ask', -1, '10', 100);
  ok(el.value === -1, 'нечисло в поле не ломает шаг', String(el.value));
}

console.log('\nРазметка кнопок');
{
  const n = (h.match(/bumpSellStep\(/g) || []).length;
  ok(n >= 4, 'по две кнопки на каждое поле', 'вызовов ' + n);
  ok(/bumpSellStep\('\$\{coin\}','\$\{pair\}','stop',-1,'\$\{totalFilled\}',\$\{totalUSD\}\)/.test(h),
    'кнопки несут объём и потраченное');
  // Плюс слева, минус справа: числа отрицательные, и глубина растёт вправо
  // (−1, −2, −3), значит правая кнопка должна уводить туда же.
  for (const [what, id] of [['stop', 'sellStepStop_'], ['ask', 'sellStepAsk_']]) {
    const iField = h.indexOf(id + '${coin}');
    const grp = h.slice(h.lastIndexOf('<span class="step-group"', iField), h.indexOf('</span>', iField));
    const iPlus = grp.indexOf("'" + what + "',1,");
    const iMinus = grp.indexOf("'" + what + "',-1,");
    ok(iPlus > 0 && iMinus > 0, what + ': обе кнопки на месте');
    ok(iPlus < iMinus, what + ': плюс слева, минус справа');
  }
  ok((h.match(/Sell Stop|SELL STOP/g) || []).length === 1, 'кнопка стоп-лимита ровно одна');
}

console.log('\nЧистая прибыль');
{
  // Комиссия обязана быть РЫНОЧНОЙ: сработавший стоп ставит лимитку по цене,
  // которая уже прошла — она забирает встречную заявку и платит как тейкер.
  const feeMarket = 0.0025, feeLimit = 0.00125;
  const qty = 139841, spent = 2482.32, limit = 0.01769;
  const pnl = qty * limit * (1 - feeMarket) - spent;
  const wrong = qty * limit * (1 - feeLimit) - spent;
  ok(wrong > pnl, 'по лимитной комиссии вышло бы больше — потому и берём рыночную',
    'разница $' + (wrong - pnl).toFixed(2));
  const none = (q, c) => (q > 0 && c > 0) ? (q * limit * (1 - feeMarket) - c) : null;
  ok(none(0, spent) === null, 'без объёма прибыль не считается');
  ok(none(qty, 0) === null, 'без потраченного тоже');

  // Расчёт живёт в общей отрисовке: её зовут и пересчёт по кнопке, и
  // обновление позиций по стакану, и первая отрисовка строки.
  const body = h.slice(h.indexOf('function sellStepInfoHtml'), h.indexOf('function sellStepPaintFromBook'));
  ok(/getFeeMarket\(\)/.test(body), 'в расчёте берётся рыночная комиссия');
  ok(!/getFeeLimit\(\)/.test(body), 'лимитная там не используется');
  // Подпись обязана рисоваться из одного места, иначе одна из веток отстанет
  ok((h.match(/sellStepInfoHtml\(/g) || []).length >= 4, 'все ветки рисуют подпись общей функцией',
    'вызовов ' + (h.match(/sellStepInfoHtml\(/g) || []).length);
  ok(/sellStepPaintFromBook\(pair, book\)/.test(h), 'подпись обновляется по уже полученному стакану');
  ok(/чистыми/.test(h), 'прибыль подписана словом, а не голым числом');
  // Цвет пишется всегда, даже когда числа ещё нет: узел на месте остаётся,
  // иначе подпись пришлось бы пересобирать — это и было мигание.
  ok(/pnl != null && pnl < 0 \? '#ff6b6b' : 'var\(--green\)'/.test(h), 'убыток красный, прибыль зелёная');
  ok(/pnl != null[\s\S]{0,80}\?/.test(h), 'без данных прибыль не рисуется');
}

console.log('\nБережность к бирже');
ok(!/recalcSellSteps\([^)]*\)\s*;\s*<\/script>/.test(h), 'пересчёт не запускается сам на каждую монету');

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
