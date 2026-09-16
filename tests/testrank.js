// Сверху должны быть монеты с измеренной частотой, а не прочерки.
//
// Порядок шёл по уровню отката: глубокий откат первым ключом. Свежих
// наблюдений в глубоких клетках пока нет, поэтому верх списка занимали четыре
// прочерка, а 79.1% стояли пятой строкой. Список, который нельзя читать
// сверху вниз, хуже отсутствия списка: глазом берётся верхняя строка.
//
// Второе: все числа были одного цвета. 57.7% и 79.1% выглядели одинаково, и
// то, что оба выше базы, на экране не было видно вовсе.
const fs = require('fs'), vm = require('vm');
const view = require('../public/js/recovery-journal');
const { recoveryBaseline, recoveryEdge, recoveryOrder, recoveryObservation, recoveryVerdict,
  renderRecoveryLegend, recoveryPeak, recoveryPeakMark, renderRecoveryTieNote,
  recoveryFresh, recoveryHeldNote } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const now = Date.now();

// Клетки как в боевом отчёте 14 сентября: база 45.1, мелкие клетки измерены,
// все глубокие тонкие.
const scan = { recoveryMeasuredAt: '2026-09-09', at: now, serverNow: now,
  gate: { fallPct: 3, spreadPct: 0.3 }, recheck: {
  current: true, code: 1, at: now, report: { version: 2, status: 'drift',
    referenceDate: '2026-09-09', from: now - 4 * 86400000, to: now - 300000, missingCoins: [],
    cells: [
      { lo: 0, deep: false, actual: 45.1, se: 3.91, coins: 23, n: 1911 },
      { lo: 1, deep: false, actual: 54.15, se: 2.79, coins: 33, n: 4537 },
      { lo: 3, deep: false, actual: 57.74, se: 2.38, coins: 36, n: 4951 },
      { lo: 3, deep: true, thin: true, coins: 1 },
      { lo: 6, deep: false, actual: 66.99, se: 2.47, coins: 24, n: 1739 },
      { lo: 6, deep: true, thin: true, coins: 3 },
      { lo: 10, deep: false, actual: 79.07, se: 1.88, coins: 13, n: 1123 },
      { lo: 10, deep: true, thin: true, coins: 5 },
    ] } } };
const gate = { fall: 3, spread: 0.3 };
const row = over => ({ coin: 'REZ', price: 1, dayFallPct: 4, pullbackPct: 0.9, chg24Pct: 1.5,
  spreadPct: 0.1, inListMin: 5, rsi: 20, ...over });
const obs = x => recoveryObservation(x, scan, now);
const order = x => recoveryOrder(x, scan, recoveryVerdict(x, gate, obs(x)), obs(x), now);

console.log('\nБаза берётся из того же замера');
{
  const base = recoveryBaseline(scan, now);
  ok(base && base.pct === 45.1 && base.se === 3.91, 'база — клетка без падения и без глубокого отката',
    base ? base.pct + '%' : 'нет');
  ok(recoveryBaseline({ ...scan, recheck: null }, now) === null, 'без свежей проверки база не выдумывается');
  ok(recoveryBaseline({ ...scan, recoveryMeasuredAt: 'other' }, now) === null, 'чужая дата замера базу не даёт');
  // Тонкая базовая клетка — не ноль и не «всё выше базы»
  const thinBase = JSON.parse(JSON.stringify(scan));
  thinBase.recheck.report.cells[0] = { lo: 0, deep: false, thin: true, coins: 4 };
  ok(recoveryBaseline(thinBase, now) === null, 'тонкая базовая клетка порога не задаёт');
  ok(renderRecoveryLegend(thinBase, now) === '', 'и подпись про порог тогда молчит');
  ok(/45\.1%/.test(renderRecoveryLegend(scan, now)), 'а иначе база названа числом');
  ok(/не разрешение покупать/.test(renderRecoveryLegend(scan, now)), 'подпись не обещает разрешения');
}

console.log('\nПорог: две ошибки разности и не меньше трёх пунктов');
{
  const base = recoveryBaseline(scan, now);
  const edge = x => recoveryEdge(obs(x), base);
  ok(edge(row({ dayFallPct: 12 })).above, 'падение больше 10% — 79.1% против базы 45.1% выделяется');
  ok(edge(row({ dayFallPct: 7 })).above, '67.0% тоже выше базы больше чем на две погрешности');
  ok(edge(row({ dayFallPct: 4 })).above, '57.7% выше базы значимо');
  // 1-3% в панель не попадает, но правило на нём видно: 54.2 против 45.1 —
  // разница 9.1 при погрешности разности 4.8, две ошибки это 9.6
  ok(!edge(row({ dayFallPct: 2 })).above, 'в пределах двух погрешностей подсветки нет',
    String(edge(row({ dayFallPct: 2 })).diff));
  ok(!edge(row({ dayFallPct: 4, pullbackPct: 2 })).above, 'без своей оценки подсветки нет');
  ok(!recoveryEdge(obs(row({ dayFallPct: 12 })), null).above, 'без базы ничего не выделяется');
  // Три пункта при крошечной ошибке: одной значимости мало
  const tight = JSON.parse(JSON.stringify(scan));
  tight.recheck.report.cells[0] = { lo: 0, deep: false, actual: 56, se: 0.1, coins: 30, n: 9000 };
  tight.recheck.report.cells[2] = { lo: 3, deep: false, actual: 58, se: 0.1, coins: 30, n: 9000 };
  ok(!recoveryEdge(recoveryObservation(row({}), tight, now), recoveryBaseline(tight, now)).above,
    'два пункта не выделяются даже при ничтожной ошибке');
  ok(/База \(падения почти нет\) 45\.1%/.test(edge(row({ dayFallPct: 12 })).why),
    'в подсказке названо, с чем сравнили');
}

console.log('\nПорядок строк: по свежести, а не по частоте');
{
  // Сортировать по частоте было первым побуждением, и проверка вне выборки
  // его отменила: на горизонте четырёх часов верхняя пятина монет по частоте
  // дала -0.332% за сделку против -0.143% у нижней (разница -0.188 ±0.064).
  // Монета касается цели чаще потому, что сильнее дёргается, — и чаще
  // достаёт до стопа. Список по частоте показывал бы на худшее.
  const fresh = row({ coin: 'NEW', dayFallPct: 4, inListMin: 2 });
  const hourOld = row({ coin: 'OLD', dayFallPct: 12, inListMin: 60 });
  const dayOld = row({ coin: 'STALE', dayFallPct: 12, inListMin: 1260 });
  ok(order(fresh) > order(hourOld), 'свежее пересечение выше давнего');
  ok(order(hourOld) > order(dayOld), 'и между давними — кто новее');
  ok(order(row({ coin: 'A', dayFallPct: 12, inListMin: 30 })) <
     order(row({ coin: 'B', dayFallPct: 4, inListMin: 10 })),
    'высокая частота сама по себе наверх не поднимает');
  ok(order(row({ dayFallPct: 12, inListMin: 30 })) === order(row({ dayFallPct: 4, inListMin: 30 })),
    'при равной свежести частота на порядок не влияет вовсе');
  ok(order(row({ dayFallPct: 12, inListMin: 1, chg24Pct: -14 })) === -1, 'риск уходит вниз');
  ok(order(fresh) > order(row({ dayFallPct: 12, inListMin: 1, chg24Pct: -14 })), 'и ниже любого кандидата');
  ok(order(row({ coin: 'NOTIME', dayFallPct: 12, inListMin: null })) < order(dayOld),
    'без времени в списке — в самый низ');
}

console.log('\nНадбавки за откат больше нет');
{
  // Раньше при равной частоте вперёд шёл более глубокий откат: в
  // историческом замере он добавлял 11-18 пунктов к частоте касания. Но
  // частота и деньги — разные вещи, а прибыльности у глубокого отката никто
  // не подтверждал. Порядок теперь событийный, и таких надбавок в нём нет.
  // Сравниваем внутри одной клетки: откат от 1.5% переносит строку в другую,
  // и разница вышла бы из-за клетки, а не из-за надбавки.
  const deeper = row({ coin: 'DEEP', pullbackPct: 1.4, inListMin: 30 });
  const flat = row({ coin: 'FLAT', pullbackPct: 0.1, inListMin: 30 });
  ok(order(deeper) === order(flat), 'глубина отката на порядок не влияет');
  ok(order(row({ pullbackPct: 1.4, inListMin: 5 })) > order(deeper), 'а свежесть влияет');
}

console.log('\nВерхняя клетка помечена отдельно');
{
  // Подсветка «выше базы» загорается почти на всех строках сразу: гейт по
  // падению сам отбирает клетки выше базы. Восемь одинаково зелёных строк не
  // выделяют ничего, поэтому верхняя клетка помечена ещё раз.
  const shown = [row({ coin: 'FIL', dayFallPct: 12 }), row({ coin: 'AAVE' }), row({ coin: 'USELESS', pullbackPct: 2 })];
  ok(recoveryPeak(shown, scan, now) === 79.1, 'максимум берётся из показанных строк',
    String(recoveryPeak(shown, scan, now)));
  ok(recoveryPeak([row({ coin: 'AAVE' })], scan, now) === 57.7, 'без верхней клетки максимум — следующая');
  ok(recoveryPeak([row({ pullbackPct: 2 })], scan, now) === null, 'из одних прочерков максимума нет');
  ok(recoveryPeak([], scan, now) === null && recoveryPeak(null, scan, now) === null, 'пустой список не ломает');
}

console.log('\nПометка «максимум» молчит, когда никого не выделяет');
{
  // Частота принадлежит клетке, а не монете: в падающем рынке весь список
  // сваливается в одну полосу падения, и «максимум» доставался пяти строкам
  // из тридцати двух. Указатель на пятерых никуда не указывает.
  const one = [row({ coin: 'FIL', dayFallPct: 12 }), row({ coin: 'AAVE' })];
  ok(recoveryPeakMark(one, scan, now).show === true, 'одна строка на вершине — пометка есть');
  ok(recoveryPeakMark(one, scan, now).count === 1, 'и счёт сходится');
  const two = [...one, row({ coin: 'XRP', dayFallPct: 11 })];
  ok(recoveryPeakMark(two, scan, now).show === true, 'две тоже помечаются');
  const three = [...two, row({ coin: 'XLM', dayFallPct: 13 })];
  ok(recoveryPeakMark(three, scan, now).show === false, 'трое и больше — пометки нет', String(recoveryPeakMark(three, scan, now).count));
  ok(renderRecoveryTieNote(three, scan, now).includes('Верхние <b>3</b> строки'),
    'вместо неё сказано, сколько строк неразличимы');
  ok(renderRecoveryTieNote(three, scan, now).includes('79.1%'), 'и названа их общая частота');
  ok(renderRecoveryTieNote(two, scan, now) === '', 'когда пометка есть, подписи нет');
  ok(renderRecoveryTieNote([], scan, now) === '', 'пустой список молчит');
  ok(renderRecoveryTieNote([row({ pullbackPct: 2 })], scan, now) === '', 'без измерения подписи нет');
  // Согласование числа: «Верхние 3 строк» роняет доверие к остальным числам
  const many = n => renderRecoveryTieNote(Array.from({ length: n },
    (_, i) => row({ coin: 'C' + i, dayFallPct: 12 })), scan, now);
  ok(many(3).includes('3</b> строки') && many(5).includes('5</b> строк') &&
    many(21).includes('21</b> строка'), 'число и слово согласованы');
  // «Риск» в вершину не попадает: у него та же клетка, но он внизу списка
  const withRisk = [...two, row({ coin: 'INJ', dayFallPct: 12, chg24Pct: -14 }),
    row({ coin: 'ZKC', dayFallPct: 13, chg24Pct: 15 })];
  ok(recoveryPeakMark(withRisk, scan, now).count === 2, 'опасные строки не считаются вершиной',
    String(recoveryPeakMark(withRisk, scan, now).count));
  ok(recoveryPeakMark(withRisk, scan, now).show === true, 'и не отнимают пометку у настоящих кандидатов');
}


console.log('\nСвежее пересечение отличается от затянувшегося движения');
{
  // Журнал записывает сигналом только первые четыре минуты: дальше это одно
  // движение, которое всё ещё идёт. На экране этого не было видно — в списке
  // стояли строки с «21 ч» и «39 ч», и выглядели они как кандидаты наравне с
  // только что появившимися.
  ok(recoveryFresh({ inListMin: 0 }) && recoveryFresh({ inListMin: 4 }), 'первые четыре минуты — свежее');
  ok(!recoveryFresh({ inListMin: 5 }) && !recoveryFresh({ inListMin: 1260 }), 'дальше уже нет');
  ok(!recoveryFresh({ inListMin: null }) && !recoveryFresh({}), 'без данных свежести не выдумываем');
  ok(/Свежее пересечение/.test(recoveryHeldNote({ inListMin: 2 })), 'свежему входу сказано, что он свежий');
  ok(/не новый сигнал/.test(recoveryHeldNote({ inListMin: 1260 })), 'затянувшемуся — что он не сигнал');
  ok(/журнал такие не записывает/.test(recoveryHeldNote({ inListMin: 1260 })), 'и что журнал его не считает');
  ok(/не влияет/.test(recoveryHeldNote({ inListMin: 1260 })), 'но и частоту цели это не меняет');
  ok(/неизвестно/.test(recoveryHeldNote({})), 'без данных так и сказано');
  // Порог тот же, по которому сервер отбирает сделки в форвардный журнал
  const server = read('server.js');
  ok(/row\.inListMin != null && row\.inListMin > 4/.test(server), 'порог совпадает с серверным');
}


console.log('\nОбе вёрстки');
for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  const src = read(file);
  const start = src.indexOf('        const swingMark = (x) => {');
  const end = src.indexOf('        box.innerHTML = head + renderRecoveryStatus', start);
  const shown = [row({ coin: 'FIL', dayFallPct: 12 }), row({ coin: 'AAVE' })];
  const ctx = { ...view, j: scan, gate, rows: shown, price: x => String(x) };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + ';this.cell = cell;', ctx);
  const hot = ctx.cell(row({ coin: 'FIL', dayFallPct: 12 }));   // верхняя клетка
  const warm = ctx.cell(row({ coin: 'AAVE' }));                 // выше базы, но не максимум
  const cold = ctx.cell(row({ coin: 'REZ', dayFallPct: 4, pullbackPct: 2 }));
  const risk = ctx.cell(row({ dayFallPct: 12, chg24Pct: -14 }));
  console.log('  ' + name);
  ok(!/var\(--blue\)/.test(warm) && /color:var\(--entry-possible\)/.test(warm), '  кандидат оранжевый, голубого в строке нет');
  ok(warm.includes('data-entry-state="possible"') && warm.includes('var(--entry-possible-bg)'), '  возможный кандидат получает оранжевую рамку и фон');
  ok(hot.includes('data-entry-state="possible"'), '  максимум без подтверждения прибыли тоже только возможный');
  ok(hot.includes(String.fromCharCode(9650)), '  у числа есть метка порога');
  ok(!/#00e5a0/.test(cold), '  прочерк не выделяется');
  ok(!cold.includes('rgba(0,180,255,0.06)'), '  и не заливается');
  ok(risk.includes('rgba(255,107,107'), '  риск остаётся красным');
  ok(!risk.includes('rgba(0,180,255,0.06)'), '  заливка наблюдения не перекрывает риск');
  ok(hot.includes('База (падения почти нет)'), '  сравнение с базой есть в подсказке');
  ok(!hot.includes('border-left:3px solid var(--blue)') && !cold.includes('border-left:3px'), '  метка максимума не перекрывает рамку статуса');
  ok(!hot.includes('#00ffa8') && !hot.includes('rgba(0,255,168'), '  максимум наблюдения не получает цвет покупки');
  ok(!hot.includes('максимум'), '  пометки «максимум» нет: выше частота не лучше');
  ok(warm.includes('максимум') === false, '  строка ниже такой пометки не получает');
  // Сортировка и подпись живут вне вырезанного куска — проверяем текстом
  ok(/recoveryOrder\(b, j, verdict\(b\), recoveryObservation\(b, j\)\) -\s*\n\s*recoveryOrder\(a, j, verdict\(a\), recoveryObservation\(a, j\)\)/.test(src),
    '  список упорядочен по измеренной частоте');
  ok(!/verdict\(b\)\.tier - verdict\(a\)\.tier/.test(src), '  прежний порядок по уровню отката убран');
  ok(/renderRecoveryLegend\(j\)/.test(src), '  подпись про порог показана');
  ok(/renderRecoveryGroups\(ranked, j, cell, [47]\)/.test(src), '  все монеты показаны в трёх группах');
  ok(!/const SHOWN = 8;/.test(src), '  ограничение восемью строками убрано');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
