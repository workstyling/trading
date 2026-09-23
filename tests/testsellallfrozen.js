// «Продать всё» — это всё, а не «всё, что не занято».
//
// Монеты держит твой же открытый ордер продажи, и биржа не примет второй
// ордер на те же монеты. Отсюда две ошибки подряд, обе дорогие.
//
// Сначала панель молча урезала объём до свободного остатка: по AURORA
// свободными оставались 0.01 монеты из 33 630, и на биржу ушли две продажи
// по два цента. Потом на их месте встал отказ — «сними открытый ордер и
// повтори». Он честный, но отвечает не на тот вопрос: человек нажал SELL ALL
// именно чтобы продать всё, а не чтобы узнать, почему нельзя.
//
// Теперь панель предлагает то, за чем и нажимали: снять мешающий ордер и
// продать разом. Снятие чужого решения — действие, поэтому спрашиваем.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');
const mob = fs.readFileSync('public/mobile/index.html', 'utf8');

// Настоящая позиция с боевого сервера: куплено 33 630.58, всё заморожено
// открытой заявкой, свободны 0.01.
const BLOCKER = { order_id: 'a5d51b1f', product_id: 'AURORA-USD', side: 'SELL', status: 'OPEN',
  order_configuration: { limit_limit_gtc: { base_size: '33630.56' } } };

function load({ avail, hold, orders = [], cancelOk = true, freedAfter = null, answer = true }) {
  const log = [];
  const cancelled = [];
  let balCalls = 0;
  const ctx = {
    Number, String, parseFloat, Promise, Math, Set, JSON, setTimeout: fn => fn(),
    AbortSignal: { timeout: () => ({}) },
    allOrders: orders, balancesCache: [], fmtSize: n => String(n),
    showCustomAlert: (t) => log.push({ k: 'alert', t }),
    showOrderError: (t, html) => log.push({ k: 'error', t, html }),
    showConfirmModal: (t, html, yes, no) => { log.push({ k: 'confirm', t, html }); (answer ? yes : no)(); },
    loadLatestOrders: async () => { log.push({ k: 'reload' }); },
    fetch: async (url, opts) => {
      if (String(url).startsWith('/get-balances')) {
        balCalls++;
        const free = freedAfter != null && balCalls > 1 ? freedAfter : avail;
        const held = freedAfter != null && balCalls > 1 ? 0 : hold;
        return { ok: true, json: async () => ({ success: true,
          balances: [{ currency: 'AURORA', available: String(free), hold: String(held) }] }) };
      }
      if (String(url) === '/cancel-order') { cancelled.push(JSON.parse(opts.body).orderId); }
      return { ok: true, json: async () => ({ success: cancelOk }) };
    },
  };
  vm.createContext(ctx);
  for (const name of ['function openSellsFor', 'async function cancelOrdersQuiet',
                      'async function waitForFreeBalance', 'function orderBaseSize',
                      'async function sellableSize']) {
    const i = h.indexOf(name);
    vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx);
  }
  vm.runInContext('this.go = sellableSize;', ctx);
  ctx.log = log; ctx.cancelled = cancelled;
  return ctx;
}

(async () => {
  console.log('\nSELL ALL снимает мешающий ордер и продаёт всё');
  {
    const c = load({ avail: 0.01, hold: 33630.56, orders: [BLOCKER], freedAfter: 33630.57 });
    const got = await c.go('AURORA', 33630.56, { requireAll: true });
    ok(got === 33630.56, 'продаётся вся позиция, а не свободные 0.01', String(got));
    const ask = c.log.find(x => x.k === 'confirm');
    ok(ask && /Снять открытый ордер и продать всё/.test(ask.t), 'сначала спросили', ask && ask.t);
    ok(ask && /33630\.56/.test(ask.html), 'названо, сколько продаём');
    ok(ask && /исполненная часть остаётся проданной/.test(ask.html),
      'и что уже продано — то продано');
    ok(c.cancelled.join() === 'a5d51b1f', 'снят именно мешающий ордер', c.cancelled.join());
    ok(!c.log.some(x => x.k === 'error'), 'ошибок при этом нет');
    ok(c.log.some(x => x.k === 'reload'), 'список ордеров перечитан');
  }

  console.log('\nОтказались снимать — ничего не отправляем');
  {
    const c = load({ avail: 0.01, hold: 33630.56, orders: [BLOCKER], answer: false });
    ok((await c.go('AURORA', 33630.56, { requireAll: true })) === null, 'продажа не уходит');
    ok(c.cancelled.length === 0, 'и ордер остаётся на месте');
    const e = c.log.find(x => x.k === 'error');
    ok(e && /Ордер остался на месте/.test(e.html), 'сказано прямо', e && e.t);
    ok(e && /не уменьшает объём до свободной части/.test(e.html),
      'и что объём до 0.01 никто не урежет');
  }

  console.log('\nОрдер не снялся — продажу не отправляем');
  {
    const c = load({ avail: 0.01, hold: 33630.56, orders: [BLOCKER], cancelOk: false });
    ok((await c.go('AURORA', 33630.56, { requireAll: true })) === null, 'ордер продажи не создан');
    const e = c.log.find(x => x.k === 'error');
    ok(e && /Ордер не снялся/.test(e.t), 'названо, что пошло не так', e && e.t);
    ok(e && /биржа отклонила бы её целиком/.test(e.html), 'и почему продажу отправлять нельзя');
  }

  console.log('\nПока ордер стоял, часть продалась');
  {
    // Освободилось меньше, чем было в позиции: «всё» стало другим числом, и
    // выдумывать его здесь нельзя — панель пересчитает по свежим ордерам.
    const c = load({ avail: 0.01, hold: 33630.56, orders: [BLOCKER], freedAfter: 500 });
    ok((await c.go('AURORA', 33630.56, { requireAll: true })) === null, 'вслепую не продаём');
    const e = c.log.find(x => x.k === 'error');
    ok(e && /монет стало меньше/.test(e.t), 'сказано, что позиция изменилась', e && e.t);
    ok(e && /500/.test(e.html) && /33630\.56/.test(e.html), 'названы оба числа');
    ok(e && /Нажми SELL ALL ещё раз/.test(e.html), 'и что делать дальше');
  }

  console.log('\nЗаморозка есть, а ордеров не видно');
  {
    const c = load({ avail: 0.01, hold: 33630.56, orders: [] });
    ok((await c.go('AURORA', 33630.56, { requireAll: true })) === null, 'наугад ничего не снимаем');
    const e = c.log.find(x => x.k === 'error');
    ok(e && /Открытых ордеров по этой монете не видно/.test(e.html), 'сказано честно', e && e.t);
    ok(c.cancelled.length === 0, 'и ничего не отменено');
  }

  console.log('\nСвободного хватает — никого не спрашиваем');
  {
    const c = load({ avail: 33630.57, hold: 0, orders: [] });
    ok((await c.go('AURORA', 33630.56, { requireAll: true })) === 33630.56, 'продаём сразу');
    ok(c.log.length === 0, 'без единого окна');
    ok(c.cancelled.length === 0, 'и ничего не снимаем');
  }

  console.log('\nСнимаются только продажи этой монеты');
  {
    const others = [
      BLOCKER,
      { order_id: 'buy1', product_id: 'AURORA-USD', side: 'BUY', status: 'OPEN' },
      { order_id: 'other', product_id: 'ENA-USD', side: 'SELL', status: 'OPEN' },
      { order_id: 'done', product_id: 'AURORA-USD', side: 'SELL', status: 'FILLED' },
    ];
    const c = load({ avail: 0.01, hold: 33630.56, orders: others, freedAfter: 33630.57 });
    await c.go('AURORA', 33630.56, { requireAll: true });
    ok(c.cancelled.join() === 'a5d51b1f', 'покупка, чужая монета и исполненный ордер не тронуты',
      c.cancelled.join() || 'ничего');
  }

  console.log('\nОжидание освобождения, а не «подождём немного»');
  {
    ok(/async function waitForFreeBalance/.test(h), 'освобождение ждут отдельной функцией');
    const start = h.indexOf('async function waitForFreeBalance');
    const body = h.slice(start, h.indexOf('\n    }', start) + 6);
    ok(/if \(last\.avail \+ 1e-9 >= need\) return last;/.test(body),
      'ждём именно нужного остатка, а не времени');
    ok(/\[400, 900, 1500, 2500\]/.test(body), 'с возрастающими паузами и конечным числом попыток');
    ok(/get-balances\?fresh=1/.test(body), 'и берут свежий баланс, а не кеш');
  }

  console.log('\nТелефон ведёт себя так же');
  {
    ok(/function openSellsForM/.test(mob), 'свои открытые продажи он тоже находит');
    ok(/async function cancelOrdersQuietM/.test(mob), 'и умеет их снять');
    ok(/async function waitForFreeBalanceM/.test(mob), 'и дождаться освобождения');
    ok(/Снять открытый ордер и продать всё\?/.test(mob), 'вопрос тот же');
    ok(/Ордер снят, монет стало меньше/.test(mob), 'и разбор случая, когда часть продалась');
    ok(/исполненная часть остаётся проданной/.test(mob), 'и та же оговорка');
    // Расхождение вёрсток однажды уже кончилось тем, что телефон звал
    // покупать запрещённое на десктопе.
    for (const text of ['Продать всё сейчас нельзя', 'Ордер не снялся',
                        'не уменьшает объём до свободной части']) {
      ok(h.includes(text) && mob.includes(text), 'обе вёрстки говорят одно: «' + text + '»');
    }
  }

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
