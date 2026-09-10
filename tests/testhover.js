// Полоса под ордером: цена, которую копируешь, и прибыль, которую видишь,
// обязаны относиться друг к другу.
//
// Полоса отдавала цену через toFixed(6), а у CP и CRO шаг цены 0.00001 — пять
// знаков. Такую цену биржа не примет как есть, а показанная прибыль считалась
// по неокруглённой: копируешь одно, видишь другое, выставляешь третье.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

console.log('\nОкругление по шагу пары');
{
  const ctx = { Number, Math };
  vm.createContext(ctx);
  const i = h.indexOf('function roundToTick');
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx);
  const f = ctx.roundToTick;
  ok(f(0.0177183, 5) === 0.01772, 'шаг 0.00001 даёт пять знаков', String(f(0.0177183, 5)));
  ok(f(0.0177183, 6) === 0.017718, 'шаг 0.000001 — шесть');
  ok(f(1234.5678, 2) === 1234.57, 'дорогая монета округляется до цента');
  // Пока шаг не спросили, работает прежнее правило: полоса не должна ждать сеть
  ok(f(0.0177183, null) === 0.017718, 'без шага — прежнее правило для дешёвых');
  ok(f(1234.5678, null) === 1234.57, 'и для дорогих');
}

console.log('\nПрибыль считается по копируемой цене');
{
  const body = h.slice(h.indexOf('function calcHover'), h.indexOf('container.addEventListener(\'mouseleave\''));
  ok(/const hoverPrice = roundToTick\(/.test(body), 'цена округляется ДО расчёта прибыли');
  ok(body.indexOf('roundToTick') < body.indexOf('filled * hoverPrice'),
    'порядок именно такой, а не наоборот');
  ok(/const priceStr = String\(hoverPrice\);/.test(h), 'показывается ровно та цена, что посчитана');
  ok(!/hoverPrice < 1 \? hoverPrice\.toFixed\(6\)/.test(h), 'прежнего второго округления не осталось');
  // Копирование и подсказка обязаны брать одно и то же
  const clicks = (h.match(/const priceStr = String\(hoverPrice\);/g) || []).length;
  ok(clicks === 2, 'подсказка и копирование берут одну и ту же цену', 'мест: ' + clicks);
}

console.log('\nДве комиссии названы');
{
  const body = h.slice(h.indexOf('function calcHover'), h.indexOf('container.addEventListener(\'mouseleave\''));
  // Главное число — по РЫНОЧНОЙ комиссии, как и колонка LIMIT: два числа
  // рядом на экране должны считаться одинаково. Мейкер идёт вторым.
  ok(/const profit = filled \* hoverPrice \* \(1 - fee\)/.test(body), 'главное число по тейкеру');
  ok(/profitMaker = filled \* hoverPrice \* \(1 - getFeeLimit\(\)\)/.test(body), 'второе — по мейкеру');
  // Подсказка теперь показывает обе ставки и оба итога — по ордеру и по
  // всей выбранной позиции.
  ok(/taker \$\{\(getFeeMarket\(\) \* 100\)\.toFixed\(3\)\}% \/ maker/.test(h),
    'обе ставки названы в подсказке');
  ok(/· maker \$\{money\(profitMaker\)\}/.test(h), 'и итог по мейкеру рядом с итогом по тейкеру');
  ok(/taker \$\{\(getFeeMarket\(\) \* 100\)/.test(h), 'и ставки названы числом, а не словом');

  // Числа на живой позиции CP
  const filled = 67935, spent = 1212.05, price = 0.01772;
  const maker = filled * price * (1 - 0.00075) - spent;
  const taker = filled * price * (1 - 0.0015) - spent;
  ok(maker > taker, 'мейкером выгоднее, чем тейкером', '$' + maker.toFixed(2) + ' против $' + taker.toFixed(2));
  ok(Math.abs((maker - taker) - filled * price * 0.00075) < 0.01,
    'разница ровно в комиссии', '$' + (maker - taker).toFixed(2));
}

console.log('\nОтличие колонки от полосы объяснено');
ok(/Полоса ниже показывает другое число, потому что считает по цене, на которую вы навели/.test(h),
  'подсказка колонки Limit называет причину расхождения');
{
  // Само расхождение — только в цене: формулы одинаковы
  const filled = 67935, spent = 1212.05, fee = 0.0015;
  const atAsk = filled * 0.01777 * (1 - fee) - spent;
  const atHover = filled * 0.017718 * (1 - fee) - spent;
  ok(Math.abs(atAsk + 6.66) < 0.05, 'колонка по ask даёт −6.66', '$' + atAsk.toFixed(2));
  ok(Math.abs(atHover + 10.18) < 0.1, 'полоса по наведённой цене даёт около −10.2', '$' + atHover.toFixed(2));
}

console.log('\nПолоса знает свою пару');
ok(/class="price-progress-container"[^>]*data-pair="\$\{pair\}"/.test(h), 'пара передана — есть у кого спросить шаг');

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
