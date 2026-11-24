'use strict';
// Наблюдение за моментом входа: разбор условий, разовое оповещение, перевзвод.
const fs = require('fs');
const vm = require('vm');
const view = require('../public/js/recovery-journal');
const { renderEntryWatch, recoveryWatchButton } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const now = Date.now();

console.log('Разбор монеты считается тем же кодом, что рисует панель');
{
  const src = read('server.js');
  const start = src.indexOf('function entryWatchAnalyze(');
  const end = src.indexOf('async function entryWatchState(', start);
  const ctx = {
    recoveryChaseEntry: view.chaseEntry,
    recoveryObservation: view.recoveryObservation,
    recoveryEdge: view.recoveryEdge,
    recoveryBaseline: view.recoveryBaseline,
    ENTRY_WATCH_RISK_CHG: 10,
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + ';this.entryWatchAnalyze = entryWatchAnalyze;', ctx);

  // Свежий отчёт сверки: база 45.1, клетка падения 3% — 57.7.
  const report = { version: 2, status: 'drift', referenceDate: '2026-09-09',
    from: now - 4 * 86400000, to: now - 300000, missingCoins: [], coins: 30, cells: [
      { lo: 0, deep: false, actual: 45.1, se: 1.2, coins: 23, n: 1911 },
      { lo: 3, deep: false, actual: 57.7, se: 1.1, coins: 36, n: 4951 },
    ] };
  const base = {
    at: now, serverNow: now, staleSince: 0, recoveryMeasuredAt: '2026-09-09',
    recheck: { current: true, code: 1, at: now, report },
    gate: { fallPct: 3, spreadPct: 0.3 },
    entryNet: { buyCells: [], target: 0.3 },
    chaseNet: { threshold: 0, verdict: 'хуже', hour: { h1: { diff: -0.24, se: 0.03 }, h2: { diff: -0.28, se: 0.02 } }, hit: {} },
    pullbackNet: { steep: { at: 3, verdict: 'хуже', hour: {} } },
  };
  const row = over => ({ coin: 'FIL', price: 2, dayFallPct: 4, pullbackPct: 0.9, spreadPct: 0.1,
    chg24Pct: -1.5, mom15Pct: -0.1, rsi: 45, ...over });
  const run = (over, scanOver) => ctx.entryWatchAnalyze('FIL',
    { ...base, ...scanOver, results: [row(over)] });

  const good = run({});
  ok(good.ready === true, 'все условия выполнены — момент настал', good.checks.filter(c => !c.ok).map(c => c.k).join(','));
  ok(good.checks.length === 7, 'разобрано семь условий', String(good.checks.length));
  ok(good.checks.every(c => c.why && c.why.length > 10), 'у каждого условия сказано, на чём оно основано');
  ok(good.hourPct === 57.7 && good.baselinePct === 45.1, 'частота и база взяты из свежей сверки');

  // Каждое условие умеет провалиться по отдельности
  const cases = [
    ['падение мельче гейта', { dayFallPct: 2.9 }, null],
    ['спред шире гейта', { spreadPct: 0.31 }, null],
    ['спред неизвестен', { spreadPct: null }, null],
    ['суточный ход за границей', { chg24Pct: -10 }, null],
    ['вход вдогонку', { mom15Pct: 0.4 }, null],
    ['резкий провал', { pullbackPct: 3.2 }, null],
    ['нет свежей сверки', {}, { recheck: null }],
    ['скан устарел', {}, { staleSince: now }],
  ];
  for (const [name, over, scanOver] of cases) {
    ok(run(over, scanOver).ready === false, 'не момент: ' + name);
  }
  // Монеты нет в скане — это «неизвестно», а не «можно»
  const absent = ctx.entryWatchAnalyze('NOPE', { ...base, results: [row({})] });
  ok(absent.ready === false && absent.inScan === false, 'монеты нет в скане — входа нет');
  ok(absent.checks.length === 1, 'и дальше условия не выдумываются');
}

console.log('Сервер: одно сообщение на одно включение');
{
  const src = read('server.js');
  const tick = src.slice(src.indexOf('setInterval(async () => {\n  if (!entryWatch.items.some(it => it.armed)) return;'),
    src.indexOf('// Сумма одной бумажной сделки'));
  ok(tick.includes('if (!item.armed) continue;'), 'выключенное оповещение молчит');
  ok(tick.includes('if (!a.ready) continue;'), 'сообщение уходит только когда совпали все условия');
  ok(tick.includes('if (!sent) {') && tick.includes('оповещение остаётся включённым'),
    'отказ Telegram не выключает оповещение: иначе момент был бы потерян молча');
  ok(tick.indexOf('item.armed = false;') > tick.indexOf('if (!sent)'), 'снимаем только после успешной отправки');
  ok(tick.includes('не обещание прибыли') || tick.includes('не окупает'), 'в сообщении сказано, что это не обещание прибыли');
  ok(!tick.includes('entryWatch.items = '), 'наблюдение после срабатывания не снимается');

  ok(/app\.post\('\/api\/entry-watch\/arm'/.test(src), 'маршрут перевзвода есть');
  const arm = src.slice(src.indexOf("app.post('/api/entry-watch/arm'"), src.indexOf("app.delete('/api/entry-watch/:coin'"));
  ok(arm.includes('tgConfigured()'), 'без настроенного Telegram включать нечего');
  ok(/entry-watch\.json/.test(read('.gitignore')), 'живые данные не едут в репозиторий');
}

console.log('Блок наблюдения');
{
  const item = { coin: 'SOL', price: 86.2, ready: false, armed: true, addedAt: now - 600000, firedAt: 0,
    checks: [{ k: 'Падение ≥3%', ok: true, v: '4%', why: 'Измерено: глубже падение — чаще возврат.' },
      { k: 'Не вдогонку', ok: false, v: '+0.4%', why: 'Вход вдогонку измеренно хуже.' }] };
  const data = { success: true, tgConfigured: true, items: [item], roundTripPct: 0.7, targetPct: 0.3 };
  const html = renderEntryWatch(data, 'arm(\'%COIN%\')', 'off(\'%COIN%\')', 'rm(\'%COIN%\')', now);
  ok(html.includes('SOL'), 'монета названа');
  ok(html.includes('ждём: 1 из 2'), 'видно, сколько условий выполнено');
  ok(html.includes('Падение ≥3%') && html.includes('Не вдогонку'), 'перечислены все условия');
  ok(html.includes('+0.4%') && html.includes('4%'), 'у каждого условия своё значение');
  ok(html.includes('оповещение включено'), 'состояние оповещения видно');
  ok(html.includes("off('SOL')") && html.includes("rm('SOL')"), 'кнопки знают свою монету');
  ok(html.includes('цель +0.3% меньше круга комиссий 0.7%'), 'честно сказано про комиссию');

  const fired = renderEntryWatch({ ...data, items: [{ ...item, armed: false, firedAt: now - 120000, firedPrice: 86.2, ready: true }] },
    'arm(\'%COIN%\')', 'off(\'%COIN%\')', 'rm(\'%COIN%\')', now);
  ok(fired.includes('сработало 2 мин назад'), 'видно, когда сработало');
  ok(fired.includes('по $86.20'), 'и по какой цене');
  ok(fired.includes("arm('SOL')") && fired.includes('Включить оповещение'), 'после срабатывания предлагается включить снова');
  ok(fired.includes('момент настал'), 'готовность условий показана отдельно от оповещения');

  ok(renderEntryWatch({ success: true, items: [] }, 'a()', 'b()', 'c()').includes('Следить'),
    'пустой блок объясняет, как добавить');
  ok(renderEntryWatch({ success: true, tgConfigured: false, items: [] }, 'a()', 'b()', 'c()').includes('Telegram не настроен'),
    'ненастроенный Telegram виден сразу');
  ok(renderEntryWatch(null, 'a()', 'b()', 'c()').includes('недоступно'), 'отсутствие данных не роняет блок');
}

console.log('Кнопка и блок в обеих вёрстках');
for (const [file, add, box, panel] of [
  ['public/index.html', 'entryWatchAdd', 'entryWatchBox', 'paperEntryBox'],
  ['public/mobile/index.html', 'entryWatchAddM', 'entryWatchBoxM', 'paperEntryBoxM'],
]) {
  const src = read(file);
  ok(src.includes("recoveryWatchButton(safe, '" + add + "("), file + ': кнопка в строке монеты');
  ok(src.includes('id="' + box + '"'), file + ': блок наблюдения на месте');
  ok(src.indexOf('id="' + box + '"') < src.indexOf('id="' + panel + '"'), file + ': блок выше бумажных сделок');
  ok(new RegExp('setInterval\\(loadEntryWatch' + (file.includes('mobile') ? 'M' : '') + ', 30000\\)').test(src),
    file + ': разбор обновляется сам');
}

console.log('Кнопка «Следить» честно описана');
{
  const b = recoveryWatchButton('SOL', 'add(\'SOL\')');
  ok(b.includes("add('SOL')") && b.includes('event.stopPropagation()'), 'жмётся и не проваливается в строку');
  ok(b.includes('одно сообщение') || b.includes('оповещение выключится само'), 'сказано, что сообщение придёт один раз');
  ok(/min-height:28px/.test(b), 'нажимается пальцем');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
