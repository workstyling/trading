'use strict';
// Поиск обвалов с разворотом: разбор монеты, отчёты в Telegram, вкладка.
const fs = require('fs');
const vm = require('vm');
const view = require('../public/js/crash-panel');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

console.log('Разбор монеты: условия из замера, неизвестное не считается выполненным');
{
  const src = read('server.js');
  const start = src.indexOf('const crashEma =');
  const end = src.indexOf('async function crashFetchBars(', start);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + ';this.crashAnalyze = crashAnalyze;', ctx);

  // Строим ряд свечей: падение, дно, небольшой отскок.
  const bars = [];
  let price = 100;
  for (let i = 0; i < 400; i++) {
    // Первые 336 часов — падение со 100 до 30, потом дно и отскок
    if (i < 330) price = 100 - (i / 330) * 70;
    else if (i < 397) price = 30 - (i - 330) * 0.1;
    else price = 23.3 + (i - 397) * 0.3;
    bars.push({ t: 1000 + i * 3600, lo: price * 0.995, hi: price * 1.005, cl: price, v: i >= 395 && i <= 396 ? 5000 : 100 });
  }
  const a = ctx.crashAnalyze('TEST', bars, 1e6);
  ok(!!a, 'монета разобрана');
  ok(a.checks.length === 8, 'восемь условий', String(a && a.checks.length));
  ok(a.checks.every(c => c.why && c.why.length > 20), 'у каждого условия названо основание');
  ok(a.fall > 70, 'глубина падения посчитана', String(a.fall));
  ok(a.rise > 0, 'рост от дна посчитан', String(a.rise));
  ok(typeof a.ready === 'boolean' && a.done <= a.total, 'счёт условий сходится', a.done + '/' + a.total);

  // Мало свечей — анализа нет вовсе, а не «всё выполнено»
  ok(ctx.crashAnalyze('X', bars.slice(0, 50), 1e6) === null, 'мало истории — разбора нет');
  ok(ctx.crashAnalyze('X', null, 1e6) === null, 'без свечей разбора нет');

  // Условие «рост от дна меньше 6%» не выполняется при большом отскоке
  const far = bars.slice();
  for (let i = 397; i < 400; i++) far[i] = { ...far[i], cl: 40, hi: 40.2, lo: 39.8 };
  const b = ctx.crashAnalyze('TEST', far, 1e6);
  const riseCheck = b.checks.find(c => c.k.includes('меньше 6%'));
  ok(riseCheck && !riseCheck.ok, 'поздний вход (большой рост от дна) условие не проходит');
}

console.log('Отчёты в Telegram: по одному на монету, выключаются');
{
  const src = read('server.js');
  const alert = src.slice(src.indexOf('async function crashAlert('), src.indexOf('function crashView('));
  ok(alert.includes('if (!crashState.alertOn || !tgConfigured()) return;'), 'выключенные отчёты молчат');
  ok(alert.includes('if (crashState.sent[r.coin]) continue;'), 'одна монета — один отчёт');
  ok(alert.includes('if (!sent)') && alert.includes('continue'), 'отказ Telegram не помечает монету отправленной');
  ok(alert.includes('r.ready'), 'отчёт уходит только по монетам со всеми условиями');
  ok(alert.includes('не сигнал к покупке') || alert.includes('находка для разбора'), 'в отчёте сказано, что это не сигнал');
  ok(alert.includes('filtered.netPct') || alert.includes('m.filtered'), 'в отчёте стоит измеренный результат');

  const route = src.slice(src.indexOf("app.post('/api/crash-alert'"), src.indexOf("app.post('/api/crash-scan/refresh'"));
  ok(route.includes('tgConfigured()'), 'включить отчёты без настроенного Telegram нельзя');
  ok(route.includes('crashState.sent = {}'), 'при включении список отправленных очищается');
  ok(route.includes('saveCrashState()'), 'выбор сохраняется сразу');
  ok(/crash-watch\.json/.test(read('.gitignore')), 'живые данные не едут в репозиторий');
  // Включённые отчёты обязаны пережить перезапуск: иначе после каждого
  // деплоя они молча выключались бы.
  const boot = src.slice(src.indexOf('let crashState ='), src.indexOf('function saveCrashState'));
  ok(boot.includes('crashState.alertOn = !!saved.alertOn'), 'при старте состояние отчётов читается из файла');
  const save = src.slice(src.indexOf('function saveCrashState'), src.indexOf('const crashEma'));
  ok(save.includes('alertOn: crashState.alertOn'), 'состояние отчётов пишется в файл');
}

console.log('Панель: находки, цена вопроса, управление');
{
  const data = { success: true, alertOn: false, tgConfigured: true, at: Date.now() - 60000, running: false,
    coins: 23, serverNow: Date.now(),
    measure: { events: 85036, coins: 289, from: '2026-07-13', to: '2026-11-23',
      all: { netPct: -0.9 }, filtered: { netPct: -0.21, netSe: 0.15, winPct: 50 }, profitableModes: 0, modesChecked: 7 },
    rows: [{ coin: 'HONEY', price: 0.00018, fall: 88.9, rise: 4.3, sinceLow: 3, rsi: 33, volFading: 0.08,
      d24: -5, vol24: 1800000, done: 8, total: 8, ready: true,
      checks: [{ k: 'Упала от максимума 14 дней ≥ 25%', ok: true, v: '88.9%', why: 'Ищем именно глубокое падение' }] }] };
  const html = view.renderCrashPanel(data, 'toggle()', 'refresh()');
  ok(html.includes('HONEY'), 'монета показана');
  ok(html.includes('−88.9%') && html.includes('от дна +4.3%'), 'падение и отскок видны сразу');
  ok(html.includes('8/8'), 'счёт условий виден');
  ok(html.includes('-0.21%') && html.includes('в плюсе 50%'), 'измеренный результат стоит в шапке');
  ok(html.includes('не сигналы к покупке'), 'сказано прямо, что это не сигналы');
  ok(html.includes('0 из 7'), 'сказано, сколько сочетаний оказались прибыльными');
  ok(html.includes('toggle()') && html.includes('refresh()'), 'кнопки на месте');
  ok(html.includes('Отчёты выключены'), 'состояние отчётов видно');
  ok(view.renderCrashPanel({ ...data, alertOn: true }, 't()', 'r()').includes('Отчёты включены'),
    'включённые отчёты тоже видны');
  ok(view.renderCrashPanel({ ...data, tgConfigured: false }, 't()', 'r()').includes('Telegram не настроен'),
    'ненастроенный Telegram виден');
  ok(view.renderCrashPanel({ ...data, rows: [] }, 't()', 'r()').includes('ничего не найдено'),
    'пустой список объяснён');
  ok(view.renderCrashPanel({ success: false, error: 'сбой' }, 't()', 'r()').includes('сбой'),
    'отказ сервера виден');
  // Правила должны называть и то, что отброшено
  ok(html.includes('Что отброшено') && html.includes('EMA50'), 'в правилах сказано, какие признаки не подтвердились');
}

console.log('Ликвидность рядом с монетой');
{
  const row = { coin: 'HONEY', price: 0.0002, fall: 88, rise: 4, sinceLow: 3, rsi: 33, volFading: 0.1,
    d24: -5, vol24: 1.8e6, mcap: 4.2e7, depth: { bid: 125000, ask: 98000 },
    done: 8, total: 8, ready: true, checks: [{ k: 'тест', ok: true, v: '1', why: 'основание теста' }] };
  const base = { success: true, alertOn: false, tgConfigured: true, at: Date.now(), running: false, coins: 1,
    serverNow: Date.now(), intervalMs: 600000,
    measure: { events: 1, coins: 1, from: 'a', to: 'b', all: { netPct: -0.9 },
      filtered: { netPct: -0.21, netSe: 0.15, winPct: 50 }, profitableModes: 0, modesChecked: 7 } };
  const html = view.renderCrashPanel({ ...base, rows: [row] }, 't()', 'r()');
  ok(html.includes('Vol24 $1.8M'), 'суточный оборот рядом с монетой');
  ok(html.includes('MCap $42.0M'), 'капитализация рядом с монетой');
  ok(html.includes('$125K') && html.includes('$98K'), 'глубина стакана ±2% по обе стороны');
  ok(html.includes('±2%'), 'глубина подписана');
  // Неизвестное остаётся неизвестным: ноль ликвидности и «нет данных» — разное
  const blind = view.renderCrashPanel({ ...base, rows: [{ ...row, mcap: null, depth: null }] }, 't()', 'r()');
  ok(blind.includes('MCap —'), 'нет капитализации — прочерк, а не ноль');
  ok(/±2%[^$]*—/.test(blind.replace(/<[^>]*>/g, '')), 'нет стакана — прочерк, а не ноль');
  ok(!blind.includes('MCap $0'), 'ноль вместо неизвестного не подставляется');
}

console.log('Сервер считает глубину и капитализацию');
{
  const src = read('server.js');
  ok(/async function crashDepth\(/.test(src), 'глубина стакана считается');
  const d = src.slice(src.indexOf('async function crashDepth('), src.indexOf('async function crashFetchBars('));
  ok(d.includes('price * 0.98') && d.includes('price * 1.02'), 'берутся именно ±2% от цены');
  ok(d.includes('return null'), 'без стакана возвращается «неизвестно»');
  ok(src.includes('a.mcap = cbMarketCap(a.coin, a.price)'), 'капитализация берётся из общего каталога');
  ok(src.includes('a.depth = await crashDepth('), 'глубина попадает в строку');
}

console.log('График TradingView и самообновление');
{
  const data = { success: true, alertOn: false, tgConfigured: true, at: Date.now() - 120000, running: false,
    coins: 20, serverNow: Date.now(), intervalMs: 600000,
    measure: { events: 1, coins: 1, from: 'a', to: 'b', all: { netPct: -0.9 },
      filtered: { netPct: -0.21, netSe: 0.15, winPct: 50 }, profitableModes: 0, modesChecked: 7 },
    rows: [{ coin: 'HONEY', price: 0.0002, fall: 88, rise: 4, sinceLow: 3, rsi: 33, volFading: 0.1,
      d24: -5, vol24: 1e6, done: 8, total: 8, ready: true, checks: [{ k: 'тест', ok: true, v: '1', why: 'основание теста' }] }] };
  const html = view.renderCrashPanel(data, 't()', 'r()');
  ok(/следующий через 8 мин/.test(html), 'видно, когда будет следующий проход', html.match(/следующий через [^<·]*/));
  ok(html.includes("crashOpenChart('HONEY')"), 'монета открывает график');
  ok(!html.includes('tradingview.com'), 'пока монета не выбрана, кадра нет');

  // Выбор монеты ставит график сверху, над списком
  view.crashShowChart('HONEY');
  const withChart = view.renderCrashPanel(data, 't()', 'r()');
  ok(view.crashChartCoin() === 'HONEY', 'выбранная монета запомнена');
  ok(withChart.includes('COINBASE%3AHONEYUSD'), 'кадр показывает нужную монету');
  ok(withChart.includes('interval=15'), 'интервал 15 минут');
  ok(withChart.includes('HONEY · 15 минут'), 'подписан интервал');
  ok(withChart.indexOf('data-crash-chart') < withChart.indexOf('HONEY</b>') ||
     withChart.indexOf('data-crash-chart') < withChart.indexOf('details'), 'график стоит выше списка');
  ok(withChart.includes('tradingview.com/chart'), 'есть ссылка открыть на TradingView');
  ok(withChart.includes('crashCloseChart()'), 'график можно закрыть');

  // Имя монеты чистится и приводится к тикеру
  view.crashShowChart('<b>he</b>');
  ok(view.crashChartCoin() === 'BHEB', 'имя монеты чистится и поднимается в верхний регистр', view.crashChartCoin());
  view.crashShowChart('');
  ok(view.crashChartCoin() === 'BHEB', 'пустое имя выбор не сбрасывает');
  view.crashCloseChartState();
  ok(view.crashChartCoin() === '' && !view.renderCrashPanel(data, 't()', 'r()').includes('tradingview'),
    'закрытие убирает кадр');
}

console.log('Вкладка в обеих вёрстках');
for (const [file, tab, root, loader] of [
  ['public/index.html', 'tab-crash', 'crashRoot', 'loadCrash'],
  ['public/mobile/index.html', 'panelCrash', 'crashRoot', 'loadCrashM'],
]) {
  const src = read(file);
  ok(src.includes('crash-panel.js'), file + ': общий код подключён');
  ok(src.includes('id="' + tab + '"'), file + ': вкладка есть');
  ok(src.includes('id="' + root + '"'), file + ': место под список есть');
  ok(src.includes('data-tab="crash"'), file + ': кнопка вкладки есть');
  ok(src.includes(loader + '()'), file + ': вкладка загружает данные');
  ok(src.includes('renderCrashPanel('), file + ': рисует общим кодом');
  // Список обновляется сам, и раскрытая карточка это переживает
  ok(new RegExp('setInterval\\(\\(\\) => \\{ if \\(document\\.getElementById\\(.[^)]+.\\)\\?\\.classList\\.contains\\(.active.\\)\\) ' + loader).test(src),
    file + ': список обновляется сам, пока вкладка открыта');
  ok(src.includes('crashOpenCoins(el)') && src.includes('crashRestoreOpen(el, open)'),
    file + ': раскрытые карточки переживают обновление');
  ok(src.includes('function crashOpenChart(coin)') && src.includes('crashShowChart(coin, paintCrash'),
    file + ': клик по монете открывает график');
  ok(src.includes('function crashCloseChart()'), file + ': график можно закрыть');
}

console.log('Бот удалён целиком');
{
  for (const f of ['public/index.html', 'public/mobile/index.html', 'server.js']) {
    const s = read(f);
    ok(!/botRoot|bot-panel|api\/bot|botLib/.test(s), f + ': следов бота нет');
  }
  ok(!fs.existsSync('src/bot'), 'папка src/bot удалена');
  ok(!fs.existsSync('public/js/bot-panel.js'), 'скрипт панели бота удалён');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
