// Торговый бот: разбивка баланса на сделки, проверка настроек и наличие раздела
// в обеих вёрстках.
const fs = require('fs');
const assert = require('assert');
const { DEFAULT_CONFIG, TEST_BALANCE_USD, planDeals, normalizeConfig, restoreState, feeSummary, spreadPct, chooseOrderTypes, trendDirection } = require('../src/bot');

let bad = 0;
const ok = (cond, message) => {
  if (!cond) bad++;
  console.log('  ' + (cond ? 'ok  ' : 'ПЛОХО') + '  ' + message);
};
const same = (actual, expected, message) => {
  let equal = true;
  try { assert.deepStrictEqual(actual, expected); } catch { equal = false; }
  ok(equal, message + (equal ? '' : ' → ' + JSON.stringify(actual)));
};

console.log('\nРазбивка на сделки');
same(planDeals(600, 2, 500), [500, 100], '600 при лимите 500 и двух сделках: 500 и 100');
same(planDeals(600, 5, 500), [500, 100], 'лишние сделки не создаются');
same(planDeals(600, 1, 500), [500], 'одна сделка: остаток не используется');
same(planDeals(14.472, 2, 500), [14.47], 'баланс меньше лимита: одна сделка на весь баланс');
same(planDeals(1000, 2, 500), [500, 500], 'баланс делится ровно');
same(planDeals(19.99, 1, 500), [19.99], 'плавающая точка не съедает цент');
same(planDeals(500.5, 2, 500), [500], 'остаток меньше минимальной сделки отбрасывается');
same(planDeals(0.5, 2, 500), [], 'меньше минимальной сделки: пусто');
same(planDeals(0, 2, 500), [], 'нулевой баланс: пусто');

console.log('\nНеизвестные данные не дают разбивки');
same(planDeals(null, 2, 500), null, 'баланс null');
same(planDeals(undefined, 2, 500), null, 'баланс undefined');
same(planDeals(NaN, 2, 500), null, 'баланс NaN');
same(planDeals(-1, 2, 500), null, 'отрицательный баланс');
same(planDeals(600, 0, 500), null, 'ноль сделок');
same(planDeals(600, 1.5, 500), null, 'дробное число сделок');
same(planDeals(600, 2, 0), null, 'нулевой лимит');

console.log('\nНастройки');
same(normalizeConfig({ coin: ' eth ', maxDeals: '3', maxUsd: '250.555' }).config,
  { coin: 'ETH', maxDeals: 3, maxUsd: 250.55 }, 'строки из формы приводятся к числам');
ok(!!normalizeConfig({ coin: '', maxDeals: 2, maxUsd: 500 }).error, 'пустая валюта отклоняется');
ok(!!normalizeConfig({ coin: 'BTC<x>', maxDeals: 2, maxUsd: 500 }).error, 'мусор в валюте отклоняется');
ok(!!normalizeConfig({ coin: 'BTC', maxDeals: '', maxUsd: 500 }).error, 'пустое число сделок отклоняется');
ok(!!normalizeConfig({ coin: 'BTC', maxDeals: 1.5, maxUsd: 500 }).error, 'дробное число сделок отклоняется');
ok(!!normalizeConfig({ coin: 'BTC', maxDeals: 101, maxUsd: 500 }).error, 'слишком много сделок отклоняется');
ok(!!normalizeConfig({ coin: 'BTC', maxDeals: 2, maxUsd: '' }).error, 'пустая сумма отклоняется');
ok(!!normalizeConfig({ coin: 'BTC', maxDeals: 2, maxUsd: 0.5 }).error, 'сумма меньше минимума отклоняется');
ok(!!normalizeConfig(null).error, 'отсутствие настроек отклоняется');

console.log('\nСостояние из файла');
const EMPTY_LEDGER = { deals: [], realizedNetUsd: 0, paidFeesUsd: 0, finishing: false, nextId: 1 };
same(restoreState(null), { mode: 'test', ...DEFAULT_CONFIG, orders: [], ...EMPTY_LEDGER }, 'без файла: тестовый режим, значения по умолчанию');
ok(DEFAULT_CONFIG.coin === 'BTC', 'валюта по умолчанию BTC');
same(restoreState({ mode: 'real', coin: 'ETH', maxDeals: 3, maxUsd: 100, orders: [{ id: 1 }], deals: [{ id: 2 }], realizedNetUsd: 5, paidFeesUsd: 7, finishing: true, nextId: 9 }),
  { mode: 'real', coin: 'ETH', maxDeals: 3, maxUsd: 100, orders: [{ id: 1 }], deals: [{ id: 2 }], realizedNetUsd: 5, paidFeesUsd: 7, finishing: true, nextId: 9 }, 'режим, настройки и журнал восстанавливаются');
ok(restoreState({ finishing: 'да' }).finishing === false, 'неверная отметка доделывания не считается');
same(restoreState({ coin: 'BTC', maxDeals: 'x', maxUsd: 100, orders: 'y', deals: 'z', realizedNetUsd: 'q', paidFeesUsd: null, nextId: 0 }),
  { mode: 'test', ...DEFAULT_CONFIG, orders: [], ...EMPTY_LEDGER }, 'повреждённый файл заменяется значениями по умолчанию');
for (const mode of [undefined, null, '', 'REAL', 'live', 1, true]) {
  ok(restoreState({ mode }).mode === 'test', 'режим ' + JSON.stringify(mode) + ' считается тестовым');
}

console.log('\nТестовый баланс');
ok(TEST_BALANCE_USD === 2000, 'тестовый баланс $2000');
same(planDeals(TEST_BALANCE_USD, 2, 500), [500, 500], 'две сделки по $500 из $2000');
same(planDeals(TEST_BALANCE_USD, 5, 500), [500, 500, 500, 500], 'пять сделок по $500: хватает на четыре');
ok(!('running' in restoreState({ coin: 'BTC', maxDeals: 2, maxUsd: 500, running: true })),
  'из файла бот не запускается');

console.log('\nКомиссии');
{
  const fees = feeSummary(0.5, 0.9);
  ok(Math.abs(fees.limitBreakevenPct - 1.00503) < 0.0001, 'Limit 0.5%: в ноль при росте около 1.005%');
  ok(Math.abs(fees.marketBreakevenPct - 1.81634) < 0.0001, 'Market 0.9%: в ноль при росте около 1.816%');
  ok(feeSummary(0, 0).limitBreakevenPct === 0, 'нулевая ставка допустима, если биржа её вернула');
  for (const bad of [null, undefined, NaN, -1, '0.5', 100]) {
    ok(feeSummary(bad, 0.9) === null && feeSummary(0.5, bad) === null, 'ставка ' + String(bad) + ': комиссии неизвестны');
  }
}

console.log('\nВыбор типа ордера');
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  ok(near(spreadPct(99, 101), 2), 'спред 99/101 равен 2%');
  ok(spreadPct(100, 100) === 0, 'нулевой спред допустим');
  for (const [bid, ask] of [[NaN, 100], [100, NaN], [0, 100], [-1, 100], [101, 100], [null, undefined]]) {
    ok(spreadPct(bid, ask) === null, 'котировка ' + bid + '/' + ask + ': спред неизвестен');
  }

  const yours = chooseOrderTypes(feeSummary(0.5, 0.9), 0.2);
  ok(yours.entry === 'limit' && yours.takeProfit === 'limit', 'покупка и цель Limit');
  ok(yours.stopLoss === 'stopLimit', 'стоп Stop-Limit');
  ok(near(yours.savingPct, 0.5), 'экономия: 0.9 + половина спреда 0.1 минус 0.5');
  const noSpread = chooseOrderTypes(feeSummary(0.5, 0.9), null);
  ok(noSpread.entry === 'limit' && noSpread.spreadKnown === false && near(noSpread.savingPct, 0.4), 'неизвестный спред: экономия только по ставке, и это отмечено');
  const odd = chooseOrderTypes(feeSummary(0.5, 0.4), 0);
  ok(odd.entry === 'limit' && near(odd.savingPct, -0.1), 'Limit дороже: тип тот же, экономия отрицательная');
  ok(chooseOrderTypes(null, 0.1) === null, 'комиссии неизвестны: не считаем');

  const old = restoreState({
    orders: [
      { id: 'A', role: 'stopLoss', type: 'market', status: 'WAITING' },
      { id: 'B', role: 'stopLoss', type: 'market', status: 'FILLED' },
      { id: 'C', role: 'takeProfit', type: 'limit', status: 'OPEN' },
    ],
  });
  ok(old.orders[0].type === 'stopLimit', 'ожидающий стоп открытой сделки переходит на Stop-Limit');
  ok(old.orders[1].type === 'market', 'исполненный стоп в истории не меняется');
  ok(old.orders[2].type === 'limit', 'цель не меняется');
}

console.log('\nНаправление');
{
  const NOW = 1800000000;
  // Свечи от новых к старым, как отдаёт Coinbase
  const series = (fn, count = 100) => Array.from({ length: count }, (_, i) => {
    const close = fn(count - 1 - i);
    return [NOW - i * 3600, close, close, close, close, 1];
  });
  ok(trendDirection(series(i => 100 + i), NOW).trend === 'up', 'устойчивый рост: вверх');
  ok(trendDirection(series(i => 300 - i), NOW).trend === 'down', 'устойчивое падение: вниз');
  ok(trendDirection(series(() => 100), NOW).trend === 'sideways', 'ровная цена: боком');
  ok(trendDirection(series(i => (i === 99 ? 90 : 100 + i)), NOW).trend !== 'up', 'обвал на последней свече: не вверх');
  const rising = trendDirection(series(i => 100 + i), NOW);
  ok(Math.abs(rising.change24hPct - (199 / 175 - 1) * 100) < 1e-9, 'изменение за 24 часа посчитано от нужной свечи');
  ok(trendDirection(series(i => 100 + i, 59), NOW) === null, 'мало свечей: неизвестно');
  ok(trendDirection(series(i => 100 + i), NOW + 4 * 3600) === null, 'устаревшие свечи: неизвестно');
  ok(trendDirection(null, NOW) === null, 'нет ответа: неизвестно');
  ok(trendDirection([], NOW) === null, 'пустой ответ: неизвестно');
  ok(trendDirection(series(i => 100 + i), undefined) === null, 'неизвестное время: неизвестно');
}

console.log('\nОбе вёрстки');
for (const [name, file] of [['десктоп', 'public/index.html'], ['телефон', 'public/mobile/index.html']]) {
  const html = fs.readFileSync(file, 'utf8');
  for (const id of ['botRoot', 'botModeTest', 'botModeReal', 'botStatus', 'botCoin', 'botMaxDeals', 'botMaxUsd', 'botStart', 'botPause', 'botFinish', 'botStop', 'botPlan', 'botFees', 'botOrderTypes', 'botDirection', 'botNote', 'botMsg', 'botOpenDeals', 'botClosedDeals', 'botNetProfit', 'botFeesPaid', 'botCancelled']) {
    ok(html.includes('id="' + id + '"'), name + ': есть ' + id);
  }
  ok(html.includes('src="/js/bot-panel.js"'), name + ': подключён общий скрипт');
  ok(html.includes('botLoad()'), name + ': открытие вкладки загружает данные');
  ok(html.indexOf('id="botModeReal"') < html.indexOf('id="botModeTest"'), name + ': «Реальный» стоит первым');
  ok(html.indexOf('id="botNetProfit"') < html.indexOf('id="botCoin"'), name + ': чистый профит наверху, над настройками');
  ok(html.includes("botStep('botMaxDeals', -1)") && html.includes("botStep('botMaxDeals', 1)"), name + ': кнопки − и + у числа сделок');
  ok(html.includes("botStep('botMaxUsd', -100)") && html.includes("botStep('botMaxUsd', 100)"), name + ': кнопки − и + у суммы');
  ok(html.includes('-webkit-inner-spin-button'), name + ': стандартные стрелки поля убраны');
}

console.log('\nНастоящие ордера не ставятся');
{
  const src = fs.readFileSync('server.js', 'utf8');
  const start = src.indexOf('// ═══ ТОРГОВЫЙ БОТ ═══');
  const section = src.slice(start, src.indexOf('// Start server — check port', start));
  ok(start >= 0 && section.length > 0, 'раздел бота найден в server.js');
  ok(!/createOrder|placeMarket|placeLimit|cancelOrders/.test(section), 'раздел бота не ставит и не снимает ордера');
  ok(/let botStatus = botStatusAfterRestart\(botState\)/.test(section), 'статус после перезапуска считается из журнала');
  const afterRestart = section.slice(section.indexOf('function botStatusAfterRestart'), section.indexOf('let botStatus ='));
  ok(/'stopped'/.test(afterRestart) && /'finishing'/.test(afterRestart) && /'paused'/.test(afterRestart) && !/'running'/.test(afterRestart), 'после перезапуска сервера новых сделок нет, открытые продолжают вестись');
  ok(/app\.post\('\/api\/bot\/finish'/.test(section), 'есть команда «Остановить и доделать»');
  ok(/botStatus === 'finishing' && !next\.deals\.length/.test(section), 'доделав последнюю сделку, бот останавливается сам');
  const engineSrc = fs.readFileSync('src/bot/engine.js', 'utf8');
  ok(!/createOrder|client\.|fetch\(|require\('\.\.\/\.\.\/cb/.test(engineSrc), 'движок не обращается к бирже');
  ok(/botState\.mode !== 'test'/.test(section.slice(section.indexOf('async function botTick'), section.indexOf('setInterval(botTick'))), 'тик работает только в тестовом режиме');
  const startRoute = section.slice(section.indexOf("app.post('/api/bot/start'"), section.indexOf("app.post('/api/bot/pause'"));
  ok(/botState\.mode !== 'test'/.test(startRoute), 'реальный режим Старт не запускает');
  const clearAt = startRoute.indexOf('botEngine.clearJournal');
  ok(clearAt > startRoute.indexOf("botState.mode !== 'test'") && clearAt > startRoute.indexOf('!view.fees'), 'журнал очищается только после всех отказов');
  ok(/if \(botStatus === 'stopped'\) \{\s*botSaveState\(botEngine\.clearJournal/.test(startRoute), 'очистка только при старте после Стопа, не с паузы');
  const stopRoute = section.slice(section.indexOf("app.post('/api/bot/stop'"), section.indexOf('// Start server'));
  ok(!/clearJournal/.test(stopRoute), 'Стоп сам журнал не очищает: результат остаётся на экране');
  ok(/app\.post\('\/api\/bot\/stop'/.test(section), 'есть команда Стоп');
  ok(/if \(!view\.fees\)/.test(section), 'без известных комиссий Старт не проходит');
  ok(/mode === 'test'\) \{\s*balance = botEngine\.cashUsd\(botState\)/.test(section), 'тестовый режим не читает баланс счёта');
  ok(/deals: mode === 'test'\s*\? botEngine\.dealViews/.test(section), 'в реальном режиме виртуальные сделки не показываются');
  const modeRoute = section.slice(section.indexOf("app.post('/api/bot/mode'"), section.indexOf("app.post('/api/bot/start'"));
  ok(/if \(botStatus !== 'stopped'\)/.test(modeRoute), 'режим меняется только у остановленного бота');
}

if (bad) { console.log('\nПЛОХО: ' + bad); process.exit(1); }
console.log('\nвсё зелено');
