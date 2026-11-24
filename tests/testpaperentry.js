'use strict';
// Ручная бумажная покупка из панели входа: расчёт прибыли, блок и кнопки.
// Настоящих ордеров эта ветка не ставит — тест сторожит и это.
const fs = require('fs');
const vm = require('vm');
const view = require('../public/js/recovery-journal');
const { renderPaperEntry, recoveryPaperButton } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

console.log('Расчёт прибыли: обе комиссии учтены, неизвестная цена — не ноль');
{
  // Вырезаем настоящую серверную функцию, а не переписываем её формулу:
  // копия формулы в тесте проверяла бы саму себя.
  const src = read('server.js');
  const start = src.indexOf('function entryPaperView(');
  const end = src.indexOf('async function entryPaperResponse(', start);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + ';this.entryPaperView = entryPaperView;', ctx);
  const fee = 0.0035;                       // 0.35% — тариф Advanced 1
  const budget = 100, entry = 10;
  const trade = { id: 'pe_1_X', coin: 'X', pair: 'X-USD', entry, budget,
    qty: budget * (1 - fee) / entry, feeEntryPct: fee, feeExitPct: fee, openedAt: 1 };

  const flat = ctx.entryPaperView(trade, entry);
  ok(flat.pnlUsd < 0, 'цена не изменилась — убыток на две комиссии, а не ноль', String(flat.pnlUsd));
  ok(Math.abs(flat.pnlUsd + 0.70) < 0.01, 'и этот убыток равен кругу комиссий 0.7%', String(flat.pnlUsd));
  ok(flat.breakeven > entry, 'выход в ноль выше цены входа', String(flat.breakeven));
  const be = ctx.entryPaperView(trade, flat.breakeven);
  ok(Math.abs(be.pnlUsd) <= 0.01, 'на цене безубытка прибыль около нуля', String(be.pnlUsd));

  const up = ctx.entryPaperView(trade, entry * 1.01);
  ok(up.pnlUsd > 0, 'рост на 1% перекрывает комиссии', String(up.pnlUsd));
  ok(Math.abs(up.pnlPct - up.pnlUsd) < 0.01, 'при сумме $100 проценты и доллары совпадают');
  const down = ctx.entryPaperView(trade, entry * 0.99);
  ok(down.pnlUsd < -1, 'падение на 1% даёт убыток больше доллара', String(down.pnlUsd));

  for (const noPrice of [null, 0, -1, undefined, NaN, 'нет']) {
    const v = ctx.entryPaperView(trade, noPrice);
    ok(v.pnlUsd === null && v.price === null, 'неизвестная цена не выдаётся за ноль: ' + String(noPrice));
  }
}

console.log('Блок сделок: итог, проценты, кнопка удаления');
{
  const data = { success: true, budgetUsd: 100, unknown: 0, totalPnlUsd: 1.23, open: [
    { id: 'pe_1_SOL', coin: 'SOL', entry: 86.2, price: 87.1, qty: 1.15, budget: 100,
      pnlUsd: 1.23, pnlPct: 1.23, breakeven: 86.9, feeEntryPct: 0.35, feeExitPct: 0.35 },
  ] };
  const html = renderPaperEntry(data, 'del(\'%ID%\')');
  ok(html.includes('SOL'), 'монета названа');
  ok(html.includes('+$1.23'), 'прибыль в долларах');
  ok(html.includes('+1.23%'), 'и в процентах');
  ok(html.includes("del('pe_1_SOL')"), 'кнопка удаления знает свою сделку');
  ok(html.includes('Удалить'), 'кнопка подписана по-русски');
  ok(/data-paper-del="pe_1_SOL"[^>]*min-height:28px/.test(html), 'кнопка удаления нажимается пальцем');
  ok(html.includes('Выход в ноль при'), 'в подсказке — цена безубытка');

  const loss = renderPaperEntry({ ...data, totalPnlUsd: -2.5,
    open: [{ ...data.open[0], pnlUsd: -2.5, pnlPct: -2.5 }] }, 'del(\'%ID%\')');
  ok(loss.includes('−$2.50'), 'убыток показан со знаком минус', loss.includes('−$2.50') ? '' : loss.slice(0, 200));
  ok(loss.includes('#ff6b6b'), 'и красным');

  // Частичная сумма, выданная за полную, — молчаливая ложь о результате.
  const partial = renderPaperEntry({ ...data, totalPnlUsd: 1.23, unknown: 2 }, 'del(\'%ID%\')');
  ok(partial.includes('(без 2)'), 'если часть цен неизвестна — об этом сказано');
  const none = renderPaperEntry({ ...data, totalPnlUsd: null, unknown: 1,
    open: [{ ...data.open[0], price: null, pnlUsd: null, pnlPct: null }] }, 'del(\'%ID%\')');
  ok(none.includes('цены неизвестны') && !none.includes('+$'), 'без цен итог не выдумывается');

  ok(renderPaperEntry({ success: true, open: [] }, 'd()').includes('Купить'), 'пустой блок объясняет, как добавить');

  // «Удалить все» — только когда есть что удалять пачкой, и подальше от
  // построчных кнопок: промах стёр бы весь журнал вместо одной строки.
  const two = { ...data, open: [data.open[0], { ...data.open[0], id: 'pe_2_ETH', coin: 'ETH' }] };
  const withAll = renderPaperEntry(two, 'del(\'%ID%\')', 'delAll()');
  ok(withAll.includes('delAll()') && withAll.includes('Удалить все (2)'), 'кнопка «удалить все» названа числом');
  ok(withAll.lastIndexOf('data-paper-del-all') > withAll.lastIndexOf('data-paper-del='), 'она стоит после построчных');
  ok(!renderPaperEntry(data, 'del(\'%ID%\')', 'delAll()').includes('data-paper-del-all'),
    'на одной сделке кнопки «удалить все» нет');
  ok(!withAll.includes('data-paper-del-all') === false && !renderPaperEntry(two, 'del(\'%ID%\')').includes('delAll'),
    'без обработчика кнопка не рисуется');
  ok(renderPaperEntry({ success: false, error: 'сервер молчит' }, 'd()').includes('сервер молчит'),
    'отказ сервера виден, а не превращается в пустое место');
  ok(renderPaperEntry(null, 'd()').includes('недоступны'), 'отсутствие данных не роняет блок');
}

console.log('Кнопка покупки честно описана');
{
  const b = recoveryPaperButton('SOL', 'buy(\'SOL\')');
  ok(b.includes("buy('SOL')") && b.includes('event.stopPropagation()'), 'жмётся и не проваливается в строку');
  // Прежняя «бум.» была серой, в девять пикселей, и пальцем по ней не попасть.
  ok(b.includes('Купить'), 'подписана словом, а не сокращением');
  ok(/min-height:28px/.test(b), 'высота хватает для пальца');
  ok(/font-size:11px/.test(b), 'шрифт читаемый');
  ok(b.includes('var(--blue)'), 'видна цветом');
  ok(!b.includes('var(--green)') && !b.includes('#00e5a0'), 'но не зелёная: зелёный здесь значит «разрешено покупать»');
  ok(b.includes('Настоящий ордер не ставится'), 'сказано, что ордера нет');
  ok(b.includes('может исполниться не сразу'), 'сказано, что лимитка по биду может ждать');
  ok(recoveryPaperButton('<b>x</b>', 'f()').includes('data-paper-buy="bxb"'), 'имя монеты чистится');
}

console.log('Сервер: вход по биду, комиссия мейкера, настоящих ордеров нет');
{
  const src = read('server.js');
  ok(/app\.get\('\/api\/paper-entry'/.test(src), 'маршрут чтения есть');
  ok(/app\.post\('\/api\/paper-entry'/.test(src), 'маршрут покупки есть');
  ok(/app\.delete\('\/api\/paper-entry\/:id'/.test(src), 'маршрут удаления есть');
  ok(/app\.delete\('\/api\/paper-entry'/.test(src), 'маршрут удаления всех есть');
  const block = src.slice(src.indexOf("app.post('/api/paper-entry'"), src.indexOf("app.delete('/api/paper-entry/:id'"));
  ok(block.includes('entry: quote.bid'), 'вход записывается по лучшему биду');
  ok(block.includes('paperLimitFee()'), 'комиссия — мейкерская, как у лимитки');
  ok(!/createOrder|placeLimit|placeMarket/.test(block), 'настоящих ордеров ветка не ставит');
  ok(block.includes('Биржа не дала цену'), 'без цены покупка отклоняется, а не придумывается');
  ok(/entry-paper-manual\.json/.test(read('.gitignore')), 'живые данные не едут в репозиторий');
  // Журнал эксперимента paper-бота остаётся отдельным
  ok(!block.includes('paperBot.open.push'), 'ручные сделки не попадают в эксперимент paper-бота');
}

console.log('Обе вёрстки');
for (const [file, buy, del, box] of [
  ['public/index.html', 'paperEntryBuy', 'paperEntryDelete', 'paperEntryBox'],
  ['public/mobile/index.html', 'paperEntryBuyM', 'paperEntryDeleteM', 'paperEntryBoxM'],
]) {
  const src = read(file);
  ok(src.includes('recoveryPaperButton(safe, \'' + buy + '('), file + ': кнопка в строке монеты');
  ok(src.includes('id="' + box + '"'), file + ': блок сделок на месте');
  // Внизу его не было видно без прокрутки всего списка: открытая позиция
  // важнее списка кандидатов, поэтому блок стоит НАД таблицей.
  const render = src.slice(src.indexOf('box.innerHTML = head + renderRecoveryStatus'));
  ok(render.indexOf('id="' + box + '"') < render.indexOf('<thead>'), file + ': блок стоит над таблицей');
  ok(src.includes('renderPaperEntry('), file + ': блок рисуется общим кодом');
  ok(new RegExp('setInterval\\(load' + (file.includes('mobile') ? 'PaperEntryM' : 'PaperEntry') + ', 15000\\)').test(src),
    file + ': прибыль обновляется онлайн');
  ok(new RegExp(del + "\\(\\\\?'%ID%\\\\?'\\)").test(src), file + ': удаление привязано к сделке');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
