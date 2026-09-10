// Сторож безубытка: ловля одного события ненадёжна.
//
// По CP позиция была (67 935 монет на $1203.26), условие постановки
// выполнялось, а сторожа не оказалось: исполнение до автоматики не дошло.
// Проверка теперь идёт ОТ СОСТОЯНИЯ: есть позиция и нет отказа — значит
// сторож должен стоять, независимо от того, какое событие потерялось.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');

const files = {};
const ctx = {
  console: { log: () => { }, error: () => { } },
  path: { join: (...a) => a.join('/') },
  fs: { existsSync: p => p in files, readFileSync: p => { if (!(p in files)) throw new Error('нет'); return files[p]; }, writeFileSync: (p, v) => { files[p] = v; } },
  JSON, Array, Date, Math, Number, parseFloat, Set, setInterval: () => 0, setTimeout: () => 0,
  __dirname: '.',
  beWatches: [],
  saveBeWatches: () => { },
  loadSettings: () => ctx._settings,
  _settings: { telegramToken: 't', telegramChat: 'c' },
  ordersCache: { data: null, ts: 0 },
  ORDERS_CACHE_TTL: 8000,
  getLatestOrders: async () => ctx._orders,
  fetchAccountBalances: async () => ctx._balances,
  _orders: [],
  _balances: [],
};
vm.createContext(ctx);
for (const fn of ['const BE_OPTOUT_FILE', 'function saveBeOptOut', 'function beOptOutAt',
                  'function beOptOutSet', 'function lastFilledBuyAt',
                  'function positionFromOrders', 'function positionAgainstWallet',
                  'async function reconcileBeWatches']) {
  const i = src.indexOf(fn);
  const end = fn.startsWith('const') ? src.indexOf('\n', i) : src.indexOf('\n}', i) + 2;
  vm.runInContext(src.slice(i, end), ctx);
}
// let beOptOut объявлена отдельной строкой — поднимаем вручную
vm.runInContext("var beOptOut = [];", ctx);

const ord = (pair, side, size, val, at) => ({
  product_id: pair, side, filled_size: String(size), total_value: String(val), status: 'FILLED',
  created_time: at ? new Date(at).toISOString() : undefined,
});

console.log('\nСверка ставит сторож там, где его нет');
(async () => {
  // Ровно случай с CP: покупка, полная продажа, снова покупка
  ctx._orders = [
    ord('CP-USD', 'BUY', 139841, 2482.32),
    ord('CP-USD', 'SELL', 139841, 2491.11),
    ord('CP-USD', 'BUY', 67935, 1212.05),
  ];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  ctx._balances = [{ currency: 'CP', total: 67935 }];
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 1 && ctx.beWatches[0].coin === 'CP', 'сторож поставлен по состоянию', JSON.stringify(ctx.beWatches[0]));
  ok(Math.abs(ctx.beWatches[0].usd - 1203.26) < 0.01, 'потраченное посчитано по всем ордерам монеты',
    '$' + ctx.beWatches[0].usd.toFixed(2));
  ok(ctx.beWatches[0].auto === true, 'помечен как поставленный сверкой');

  // Повторный проход не должен дублировать
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 1, 'повторная сверка не дублирует');

  console.log('\nОтказ уважается');
  ctx.beWatches = [];
  ctx.beOptOutSet('CP', true);
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'снятый руками сторож сверка не возвращает');
  ctx.beOptOutSet('CP', false);
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 1, 'после снятия отказа ставится снова');

  // Отказ относится к позиции, а не к монете навсегда.
  //
  // Раньше снять его умел единственный путь — ловля исполнения на лету.
  // Стоило событию пройти мимо (перезапуск, окно кеша, разошедшийся опрос), и
  // монета оставалась в отказе насовсем: сверка её пропускала, и после новой
  // покупки сторож приходилось включать руками. Ровно это и было с USELESS.
  console.log('\nНовая покупка снимает отказ');
  ctx.beWatches = [];
  ctx.beOptOutSet('CP', true);              // сторож сработал по прежней позиции
  const off = ctx.beOptOutAt('CP');
  ok(typeof off === 'number' && off > 0, 'отказ помнит время');
  ctx._orders = [ord('CP-USD', 'BUY', 67935, 1212.05, off - 60_000)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'покупка ДО отказа его не снимает — это та же позиция');

  ctx._orders = [ord('CP-USD', 'BUY', 67935, 1212.05, off + 60_000)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 1, 'покупка ПОСЛЕ отказа — сторож встаёт сам');
  ok(ctx.beOptOutAt('CP') === null, 'и отказ снят, а не оставлен висеть');
  ctx._orders = [ord('CP-USD', 'BUY', 67935, 1212.05)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };

  console.log('\nЧего сторожить не надо');
  ctx.beWatches = [];
  ctx._orders = [ord('CP-USD', 'BUY', 100, 50), ord('CP-USD', 'SELL', 100, 51)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  ctx._balances = [];
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'закрытая позиция сторожа не получает');
  // Пыль: остаток на копейки
  ctx._orders = [ord('CP-USD', 'BUY', 100, 50), ord('CP-USD', 'SELL', 99, 49.5)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  ctx._balances = [{ currency: 'CP', total: 1 }];
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'пыль на полдоллара позицией не считается');

  console.log('\nБез Telegram не ставим');
  ctx.beWatches = [];
  ctx._orders = [ord('CP-USD', 'BUY', 67935, 1212.05)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  ctx._balances = [{ currency: 'CP', total: 67935 }];
  ctx._settings = {};
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'сторож, который не может позвать, не заводится');
  ctx._settings = { telegramToken: 't', telegramChat: 'c' };

  console.log('\nСвязи в коде');
  ok(/beOptOutSet\(w\.coin, true\);/.test(src), 'сработавший сторож помечается отказом — иначе слал бы снова');
  ok(/beOptOutSet\(coin, true\);[\s\S]{0,120}beWatches = beWatches\.filter/.test(src),
    'снятие руками тоже отказ');
  ok(/beOptOutSet\(coin, false\);[\s\S]{0,200}beWatches\.push/.test(src), 'включение руками отказ снимает');
  ok(/setInterval\(reconcileBeWatches, 2 \* 60 \* 1000\)/.test(src), 'сверка идёт раз в две минуты');
  ok(/setTimeout\(reconcileBeWatches, 45_000\)/.test(src), 'и вскоре после запуска');
  // Покупка перед самым перезапуском попадает в первый молчаливый проход:
  // сообщения нет, и сторожа раньше тоже не было.
  ok(/fillBaselineDone = true;[\s\S]{0,400}reconcileBeWatches\(\)/.test(src),
    'после молчаливого первого прохода состояние всё равно сверяется');
  // Клиент дёргает проверку сразу после сделки, а кеш ордеров сделан ДО неё
  ok(/async function checkFilledOrders\(fresh\)/.test(src), 'проверка умеет обойти кеш');
  ok(/await checkFilledOrders\(true\);/.test(src), 'и запрос с клиента её об этом просит');
  // Старая запись — голое имя монеты; время неизвестно, и считать его давним
  // нельзя: иначе прошлая покупка сняла бы отказ и сторож выстрелил бы снова
  ok(/typeof x === 'string' \? \{ coin: x, t: Date\.now\(\) \}/.test(src),
    'старый список монет переносится в новый формат');


  console.log('\nКошелёк — истина');
  ctx.beWatches = [];
  ctx.beOptOut = [];
  // Список ордеров это ОКНО: покупка в нём, продажа за краем — и монета
  // выглядит купленной. Ровно так сверка поставила сторожей на BILL, KTA и
  // FORTH, которых в кошельке нет, они сработали по безубытку и прислали
  // сообщения о давно закрытых сделках.
  ctx._orders = [ord('BILL-USD', 'BUY', 17335, 331.28)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  ctx._balances = [];
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'монеты нет в кошельке — сторож не ставится');

  // Количество расходится: история неполная, порог считался бы по чужим числам
  ctx._balances = [{ currency: 'BILL', total: 500 }];
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'расхождение с кошельком — тоже отказ');

  ctx._balances = [{ currency: 'BILL', total: 17335 }];
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 1, 'когда кошелёк подтверждает — ставится');

  // Уже стоящий сторож на несуществующую монету снимается, даже ручной
  ctx.beWatches = [{ coin: 'GONE', pair: 'GONE-USD', filled: 1, usd: 1, t: 0 }];
  ctx._balances = [];
  ctx._orders = [];
  ctx.ordersCache = { data: [], ts: Date.now() };
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'сторож на монету, которой нет, снимается');

  // Без баланса проход пропускается целиком: слепая сверка опаснее её отсутствия
  ctx.beWatches = [];
  ctx.fetchAccountBalances = async () => { throw new Error('биржа молчит'); };
  ctx._orders = [ord('CP-USD', 'BUY', 67935, 1212.05)];
  ctx.ordersCache = { data: ctx._orders, ts: Date.now() };
  await ctx.reconcileBeWatches();
  ok(ctx.beWatches.length === 0, 'без баланса сверка не гадает, а пропускает проход');
  ctx.fetchAccountBalances = async () => ctx._balances;

  console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
  process.exit(bad ? 1 : 0);
})();
