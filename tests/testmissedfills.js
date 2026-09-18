// Исполнение, которого панель не видит, держит сделку открытой навсегда.
//
// Остаток позиции считается по ВЫБРАННЫМ ордерам. Снятая заявка, успевшая
// продать часть объёма, в выбранное не попадает: по USELESS куплено 11 858.70,
// продано 11 820.90, и панель считала, что осталось 37.80 — при пустом
// кошельке. Кнопка записи прибыли молчала «ещё открыта», круг не замыкался, и
// в историю он не попал бы никогда.
//
// Само приложение это не чинит молча: какие ордера складывать в одну сделку —
// решение человека, и добавлять к нему чужие круги за него нельзя. Но найти
// пропущенное и сделать это одним нажатием — можно.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

// Настоящие ордера USELESS с боевого сервера
const t = (s) => new Date(s).toISOString();
const ORDERS = [
  // прежний круг по той же монете — другая сделка, трогать её нельзя
  { order_id: 'old1', product_id: 'USELESS-USD', side: 'BUY', status: 'FILLED',
    filled_size: '3357.4', created_time: t('2026-09-11T13:57:00Z') },
  { order_id: 'old2', product_id: 'USELESS-USD', side: 'SELL', status: 'FILLED',
    filled_size: '3357.4', created_time: t('2026-09-11T14:01:00Z') },
  // текущая сделка
  { order_id: 'df3e9215', product_id: 'USELESS-USD', side: 'BUY', status: 'FILLED',
    filled_size: '11858.7', created_time: t('2026-09-18T08:17:00Z') },
  { order_id: '8af8cd03', product_id: 'USELESS-USD', side: 'SELL', status: 'CANCELLED',
    filled_size: '37.8', created_time: t('2026-09-18T08:24:00Z') },
  { order_id: 'c968d828', product_id: 'USELESS-USD', side: 'SELL', status: 'FILLED',
    filled_size: '11820.9', created_time: t('2026-09-18T09:40:00Z') },
  // другая монета — не наше дело
  { order_id: 'x1', product_id: 'ENA-USD', side: 'SELL', status: 'CANCELLED',
    filled_size: '100', created_time: t('2026-09-18T09:00:00Z') },
  // без исполнения — нечего учитывать
  { order_id: 'empty', product_id: 'USELESS-USD', side: 'SELL', status: 'CANCELLED',
    filled_size: '0', created_time: t('2026-09-18T09:50:00Z') },
];

// Тот же отбор, что в панели
function findMissed({ selected, muted = [] }) {
  const active = ORDERS.filter(o => selected.includes(o.order_id) && !muted.includes(o.order_id));
  const firstSelT = active.reduce((min, o) => {
    const x = o.created_time ? new Date(o.created_time).getTime() : NaN;
    return Number.isFinite(x) && x < min ? x : min;
  }, Infinity);
  return Number.isFinite(firstSelT) ? ORDERS.filter(o => {
    if (o.product_id !== 'USELESS-USD') return false;
    if (!(parseFloat(o.filled_size) > 0)) return false;
    if (selected.includes(o.order_id) || muted.includes(o.order_id)) return false;
    const x = o.created_time ? new Date(o.created_time).getTime() : NaN;
    return Number.isFinite(x) && x >= firstSelT;
  }) : [];
}

console.log('\nЧто находится, а что нет');
{
  const missed = findMissed({ selected: ['df3e9215', 'c968d828'] });
  ok(missed.length === 1, 'найдено ровно одно пропущенное исполнение', 'их ' + missed.length);
  ok(missed[0] && missed[0].order_id === '8af8cd03', 'именно снятая заявка, продавшая 37.80',
    missed[0] && missed[0].order_id);
  ok(!missed.some(o => o.order_id.startsWith('old')),
    'прежний круг по той же монете не втягивается — это другая сделка');
  ok(!missed.some(o => o.product_id !== 'USELESS-USD'), 'чужая монета не берётся');
  ok(!missed.some(o => o.order_id === 'empty'), 'снятая заявка без исполнения не предлагается');
}

console.log('\nПосле учёта круг закрывается');
{
  const sum = (ids) => ORDERS.filter(o => ids.includes(o.order_id))
    .reduce((a, o) => a + (o.side === 'BUY' ? 1 : -1) * parseFloat(o.filled_size), 0);
  const was = sum(['df3e9215', 'c968d828']);
  ok(Math.abs(was - 37.8) < 0.01, 'до учёта остаток 37.80 — при пустом кошельке', String(was));
  const now = sum(['df3e9215', 'c968d828', '8af8cd03']);
  ok(Math.abs(now) < 0.01, 'после учёта остаток ноль, позиция закрыта', String(now));
  // Деньги: куплено 3078.12, продано 3079.80 + 9.88
  const pnlBefore = 3079.80 - 3078.12;
  const pnlAfter = 3079.80 + 9.88 - 3078.12;
  ok(Math.abs(pnlBefore - 1.68) < 0.01, 'без учёта прибыль вышла бы $1.68', '$' + pnlBefore.toFixed(2));
  ok(Math.abs(pnlAfter - 11.56) < 0.01, 'а с учётом — $11.56', '$' + pnlAfter.toFixed(2));
  ok(pnlAfter > pnlBefore, 'то есть без учёта прибыль занижена на выручку снятой заявки',
    '$' + (pnlAfter - pnlBefore).toFixed(2));
}

console.log('\nНажатие добавляет в выбранное');
{
  const ctx = {
    String, console: { log: () => {} },
    selectedOrders: ['df3e9215', 'c968d828'],
    saved: 0, alerts: [],
    saveSelectedOrders() { ctx.saved++; },
    showCustomAlert(t, err) { ctx.alerts.push({ t, err: !!err }); },
  };
  vm.createContext(ctx);
  const i = h.indexOf('function addMissedFills');
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6) + ';this.add = addMissedFills;', ctx);

  ctx.add('8af8cd03');
  ok(ctx.selectedOrders.includes('8af8cd03'), 'ордер попал в выбранное');
  ok(ctx.saved === 1, 'выбор сохранён — панель перерисуется');
  ok(ctx.alerts[0] && /Учтено исполнений: 1/.test(ctx.alerts[0].t), 'и сказано, что именно произошло',
    ctx.alerts[0] && ctx.alerts[0].t);

  // Повтор ничего не ломает и не врёт про успех
  ctx.add('8af8cd03');
  ok(ctx.selectedOrders.filter(x => x === '8af8cd03').length === 1, 'повтор не дублирует ордер');
  ok(ctx.saved === 1, 'и не переписывает выбор впустую');
  ok(ctx.alerts[1] && ctx.alerts[1].err, 'повтор честно говорит, что добавлять нечего');

  // Несколько сразу
  ctx.add('a,b,,c');
  ok(ctx.selectedOrders.includes('a') && ctx.selectedOrders.includes('c'), 'список разбирается');
  ok(!ctx.selectedOrders.includes(''), 'пустые куски списка не попадают в выбранное');
}

console.log('\nКнопка и подсказки на месте');
{
  ok(/const missedNote = missed\.length/.test(h), 'кнопка показывается только когда есть что учесть');
  ok(/onclick="addMissedFills\('\$\{missed\.map\(o => o\.order_id\)\.join\(','\)\}'\)"/.test(h),
    'она несёт найденные номера ордеров');
  ok(/учесть ещё \$\{missed\.length\} исполн\./.test(h), 'на кнопке сказано, сколько найдено');
  ok(/\$\{shortNote\}\$\{missedNote\}/.test(h), 'стоит рядом с объяснением расхождения');
  // Подпись отключённой кнопки не должна врать про «дождись полного выхода»,
  // когда выход уже полный, а панель его просто не видит
  ok(/Save Profit — есть неучтённое/.test(h), 'кнопка записи называет настоящую причину');
  ok(/найдено \$\{missed\.length\} исполнен/.test(h), 'и подсказка тоже');
  ok(/о === 1 \? 'ие' : 'ия'/.test(h) || /missed\.length === 1 \? 'ие' : 'ия'/.test(h),
    'число согласовано со словом');
  // Ордера не пропадают: учёт — это галочка, а не изменение сделки
  ok(/их всегда можно снять галочкой/.test(h), 'сказано, что действие обратимо');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
