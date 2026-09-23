// Телефон: новый ордер сразу отмечен, снятый пустой — сразу снят.
//
// Позиция в панели считается по ОТМЕЧЕННЫМ ордерам. Не отметить только что
// созданный — значит не замкнуть круг: покупка есть, продажи в расчёте нет, и
// запись прибыли не включается. Часть путей на телефоне отмечала, часть нет,
// и одна и та же сделка выглядела по-разному в зависимости от того, какой
// кнопкой её поставили.
//
// Обратное действие НЕ симметрично: снимать отметку можно только с ордера, по
// которому ничего не прошло. Снятая заявка могла успеть исполниться частично,
// и эти монеты обязаны остаться в расчёте — на десктопе ровно на этом
// терялись проданные монеты (USELESS, 37.80 монеты и $9.88 выручки).
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const mob = fs.readFileSync('public/mobile/index.html', 'utf8');

function load(selected, passes) {
  let n = 0;
  const ctx = {
    Number, String, parseFloat, Promise, setTimeout,
    selectedOrders: [...selected], allOrders: [], saved: 0, rendered: 0, monitored: 0,
    saveSelectedToServer() { ctx.saved++; },
    renderOrders() { ctx.rendered++; },
    updateMonitor() { ctx.monitored++; },
    loadOrders: async () => { ctx.allOrders = passes[Math.min(n, passes.length - 1)]; n++; },
  };
  vm.createContext(ctx);
  for (const name of ['function selectNewOrderM', 'async function dropFromSelectedIfEmptyM']) {
    const i = mob.indexOf(name);
    vm.runInContext(mob.slice(i, mob.indexOf('\n    }', i) + 6), ctx);
  }
  vm.runInContext('this.add = selectNewOrderM; this.drop = dropFromSelectedIfEmptyM;', ctx);
  return ctx;
}

(async () => {
  console.log('\nНовый ордер отмечается');
  {
    const c = load([], [[]]);
    c.add('new1');
    ok(c.selectedOrders.join() === 'new1', 'ордер попал в отмеченные', c.selectedOrders.join());
    ok(c.saved === 1, 'и выбор сохранён на сервер');
    c.add('new1');
    ok(c.selectedOrders.length === 1 && c.saved === 1, 'повтор не дублирует и не пишет впустую');
    c.add(null); c.add(undefined); c.add('');
    ok(c.selectedOrders.length === 1 && c.saved === 1, 'пустой номер ордера не отмечается');
  }

  console.log('\nСнятый пустой ордер — отметка уходит');
  {
    const c = load(['a', 'b'], [[{ order_id: 'a', status: 'CANCELLED', filled_size: '0' }]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'b', 'снят из отмеченных', c.selectedOrders.join());
    ok(c.saved === 1, 'выбор сохранён');
    ok(c.rendered >= 1 && c.monitored >= 1, 'список и монитор перерисованы');
  }

  console.log('\nСнятый с исполнением — отметка остаётся');
  {
    // Ровно случай USELESS: заявка успела продать часть и была снята. Эти
    // монеты обязаны остаться в расчёте позиции.
    const c = load(['a', 'b'], [[{ order_id: 'a', status: 'CANCELLED', filled_size: '37.8' }]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'a,b', 'проданная часть не выпадает из расчёта');
    ok(c.saved === 0, 'и выбор не трогается');
  }

  console.log('\nОтмена доходит до биржи не мгновенно');
  {
    // Первый ответ ещё «в стакане» — решать по нему нельзя.
    const c = load(['a'], [
      [{ order_id: 'a', status: 'OPEN', filled_size: '0' }],
      [{ order_id: 'a', status: 'CANCELLED', filled_size: '12' }],
    ]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'a', 'исполнение, доехавшее вторым ответом, сохраняется');
  }

  console.log('\nОрдера не видно — оставляем');
  {
    const c = load(['a'], [[]]);
    await c.drop('a');
    ok(c.selectedOrders.join() === 'a',
      'потерять исполнение хуже, чем оставить лишнюю строку');
    ok(c.saved === 0, 'и выбор не переписывается');
  }

  console.log('\nВсе пути создания идут через один вход');
  {
    const uses = (mob.match(/selectNewOrderM\(/g) || []).length;
    ok(uses >= 9, 'помощник зовут отовсюду, где создаётся ордер', 'мест ' + uses);
    // Прямых push должно остаться ровно два: ручная галочка и сам помощник.
    const pushes = (mob.match(/selectedOrders\.push\(/g) || []).length;
    ok(pushes === 2, 'своих копий отметки не осталось', 'push: ' + pushes);
    const manual = mob.slice(mob.indexOf('function toggleSelectOrder'), mob.indexOf('function toggleSelectOrder') + 400);
    ok(/selectedOrders\.push\(id\)/.test(manual), 'ручная галочка работает как работала');
  }

  console.log('\nОтмена зовёт проверку, а не снимает вслепую');
  {
    const body = mob.slice(mob.indexOf('async function cancelOrder(id)'),
      mob.indexOf('async function cancelOrder(id)') + 700);
    ok(/await dropFromSelectedIfEmptyM\(id\)/.test(body), 'отмена проверяет исполнение');
    ok(!/selectedOrders\.filter/.test(body), 'и не снимает отметку сама');
    // Проверка сама перечитывает ордера — второй загрузки быть не должно
    ok(!/loadOrders\(\);/.test(body), 'список не перечитывается дважды');
  }

  console.log('\nТо же правило, что на десктопе');
  {
    const d = fs.readFileSync('public/index.html', 'utf8');
    ok(/async function dropFromSelectedIfEmpty\b/.test(d) &&
       /async function dropFromSelectedIfEmptyM\b/.test(mob), 'проверка есть в обеих вёрстках');
    for (const [name, src] of [['десктоп', d], ['мобильная', mob]]) {
      const i = src.indexOf(name === 'десктоп' ? 'async function dropFromSelectedIfEmpty(' :
        'async function dropFromSelectedIfEmptyM(');
      const body = src.slice(i, src.indexOf('\n    }', i) + 6);
      ok(/if \(!terminal \|\| filled !== 0\) return;/.test(body),
        name + ': отметка снимается только с окончательного и пустого ордера');
      // Пустое поле — это «неизвестно», а не ноль. «|| 0» сняло бы отметку с
      // ордера, про который ничего не известно.
      ok(!/parseFloat\(fresh\.filled_size \|\| 0\)/.test(body),
        name + ': неизвестное исполнение не считается нулём');
      ok(/'OPEN' && st !== 'PENDING' && st !== 'QUEUED'/.test(body),
        name + ': и только когда отмена дошла до биржи');
    }
  }

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
