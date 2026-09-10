// Частично исполненный ордер: биржа отдаёт стоимость ВСЕГО ордера, а не
// исполненной части. На стоп-лимите по CRO это дало $2494.82 вместо настоящих
// $1200.33 — приложение решило, что за проданную половину получено вдвое
// больше, потраченное вышло отрицательным, и прибыль показалась как +$1297
// при реальных двух с половиной долларах.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');

const ctx = { Number, Math, parseFloat, console };
vm.createContext(ctx);
vm.runInContext(src.match(/function partialValue[\s\S]*?\n}/)[0], ctx);

console.log('\nСтоимость исполненной части');
{
  const f = ctx.partialValue;
  // Настоящий ордер по CRO: filled_value 1200.325539, комиссия 1.420761471
  ok(Math.abs(f({ side: 'SELL', filled_value: '1200.325539', total_fees: '1.420761471' }) - 1198.9048) < 0.001,
    'с продажи комиссия удерживается', String(f({ side: 'SELL', filled_value: '1200.325539', total_fees: '1.420761471' })));
  // За покупку комиссия платится СВЕРХ — знак противоположный
  ok(f({ side: 'BUY', filled_value: '1000', total_fees: '2.5' }) === 1002.5, 'за покупку комиссия добавляется');
  ok(f({ side: 'SELL', filled_value: '0', total_fees: '0' }) === 0, 'ничего не исполнено — ноль');
  ok(f({ side: 'SELL', filled_value: '', total_fees: null }) === 0, 'мусор даёт ноль, а не NaN');
  ok(f({ side: 'SELL' }) === 0, 'отсутствующие поля не роняют расчёт');
  // Комиссия больше выручки быть не может, но если биржа отдаст чушь —
  // отрицательных денег в панели быть не должно
  ok(f({ side: 'SELL', filled_value: '1', total_fees: '5' }) === 0, 'отрицательного результата не бывает');
}

console.log('\nЗавершённые ордера не трогаем');
{
  const m = src.slice(src.indexOf('total_value: order.status'), src.indexOf('limit_price: limitConfig'));
  ok(/order\.status === 'FILLED'/.test(m), 'признак завершённости проверяется');
  ok(/order\.total_value_after_fees \|\| order\.filled_value/.test(m),
    'у завершённых берётся прежняя величина — на ней построена вся история прибыли');
  ok(/partialValue\(order\)/.test(m), 'у остальных считается исполненная часть');
}

console.log('\nЧто увидит панель на живых числах CRO');
{
  const boughtQty = 41421.9, boughtUsd = 2491.03;
  const soldQty = 19902.1;
  const soldNet = ctx.partialValue({ side: 'SELL', filled_value: '1200.325539', total_fees: '1.420761471' });
  const rest = boughtQty - soldQty;
  const netUsd = boughtUsd - soldNet;
  ok(Math.abs(rest - 21519.8) < 0.01, 'осталось монет посчитано верно', rest.toFixed(1));
  ok(netUsd > 0, 'вложенное перестало быть отрицательным', '$' + netUsd.toFixed(2));
  const pnl = rest * 0.06021 * (1 - 0.00075) - netUsd;
  ok(Math.abs(pnl) < 50, 'прибыль стала правдоподобной, а не тысячной', '$' + pnl.toFixed(2));
  // Прежняя формула на тех же числах давала бессмыслицу — фиксируем разницу
  const wrongUsd = boughtUsd - 2494.817126822;
  const wrongPnl = rest * 0.06021 * (1 - 0.00075) - wrongUsd;
  ok(wrongPnl > 1000, 'прежняя формула давала больше тысячи — это и видел пользователь', '$' + wrongPnl.toFixed(2));
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
