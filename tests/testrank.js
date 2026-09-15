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
  renderRecoveryLegend, renderRecoveryDeepNote, recoveryPeak } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const now = Date.now();

// Клетки как в боевом отчёте 14 сентября: база 45.1, мелкие клетки измерены,
// все глубокие тонкие.
const scan = { recoveryMeasuredAt: '2026-09-09', at: now, serverNow: now, recheck: {
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

console.log('\nПорядок строк');
{
  ok(order(row({ dayFallPct: 12 })) > order(row({ dayFallPct: 4 })), 'выше частота — выше строка');
  // Строка без своей оценки стоит ниже любой измеренной: «нет оценки» — это
  // не кандидат на покупку, и держать его над числом значит возвращать ту же
  // ошибку. Между собой прочерки идут по известной мелкой клетке того же
  // падения: глубокий откат в историческом замере шёл не хуже мелкого.
  const deepBig = row({ coin: 'USELESS', dayFallPct: 9.73, pullbackPct: 3.14, chg24Pct: -9.12 });
  ok(obs(deepBig).hour === null, 'у глубокой клетки своей оценки пока нет');
  ok(order(deepBig) < order(row({ dayFallPct: 4 })), 'прочерк уходит ниже любой измеренной строки');
  ok(order(deepBig) > order(row({ coin: 'ARB', dayFallPct: 4.12, pullbackPct: 1.63 })),
    'между прочерками порядок по своему падению');
  ok(order(row({ dayFallPct: 6.5 })) > order(deepBig), 'при равной клетке известное число впереди прочерка');
  // Риск — всегда вниз, какая бы частота ни была
  ok(order(row({ dayFallPct: 12, chg24Pct: -14 })) < order(row({ dayFallPct: 4 })), 'риск уходит вниз');
  ok(order(row({ dayFallPct: 12, chg24Pct: -14 })) === -1, 'и он ниже любой строки без оценки');
  ok(order(row({ dayFallPct: 12 })) > 1000 && order(deepBig) < 1000, 'измеренное и неизмеренное не перемешиваются');
  // Без свежего отчёта порядок не ломается и не выдумывается
  const blind = { ...scan, recheck: null };
  const o = x => recoveryOrder(x, blind, recoveryVerdict(x, gate, recoveryObservation(x, blind, now)),
    recoveryObservation(x, blind, now), now);
  ok(o(row({ dayFallPct: 12 })) === 0 && o(row({ dayFallPct: 4 })) === 0, 'нет замера — нет и порядка по нему');
}

console.log('\nОшедшие под черту не пропадают молча');
{
  const deepBig = row({ coin: 'USELESS', dayFallPct: 9.73, pullbackPct: 3.14, chg24Pct: -9.12 });
  const note = renderRecoveryDeepNote([row({ coin: 'FIL', dayFallPct: 12 }), deepBig], 1, scan, now);
  ok(/USELESS/.test(note), 'монета с глубоким откатом названа под таблицей');
  ok(/11-18 пунктов/.test(note), 'и сказано, чем она была хороша в историческом замере');
  ok(renderRecoveryDeepNote([deepBig], 1, scan, now) === '', 'показанная строка в примечание не попадает');
  ok(renderRecoveryDeepNote([row({ dayFallPct: 12 })], 0, scan, now) === '',
    'измеренная строка под чертой примечания не требует');
  ok(renderRecoveryDeepNote([row({ pullbackPct: 0.9 })], 0, scan, now) === '',
    'мелкий откат в примечание не идёт');
  ok(renderRecoveryDeepNote(null, 0, scan, now) === '', 'без списка примечание молчит');
  // Когда клетки наберут данные, примечание должно исчезнуть само
  const full = JSON.parse(JSON.stringify(scan));
  full.recheck.report.cells[5] = { lo: 6, deep: true, actual: 82, se: 2, coins: 20, n: 900 };
  ok(renderRecoveryDeepNote([row({}), deepBig], 1, full, now) === '',
    'появилась своя оценка — примечание уходит');
}

console.log('\nПри равной частоте вперёд идёт глубокий откат');
{
  ok(order(row({ coin: 'UNI', pullbackPct: 1.38 })) > order(row({ coin: 'DASH', pullbackPct: 0.59 })),
    'глубже откат — выше строка');
  ok(order(row({ dayFallPct: 12, pullbackPct: 0 })) > order(row({ dayFallPct: 4, pullbackPct: 1.4 })),
    'но надбавка за откат не перебивает измеренную разницу');
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

console.log('\nОбе вёрстки');
for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  const src = read(file);
  const start = src.indexOf('        const swingMark = (x) => {');
  const end = src.indexOf('        box.innerHTML = head + renderRecoveryStatus', start);
  const shown = [row({ coin: 'FIL', dayFallPct: 12 }), row({ coin: 'AAVE' })];
  const ctx = { ...view, j: scan, gate, good: shown, price: x => String(x) };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + ';this.cell = cell;', ctx);
  const hot = ctx.cell(row({ coin: 'FIL', dayFallPct: 12 }));   // верхняя клетка
  const warm = ctx.cell(row({ coin: 'AAVE' }));                 // выше базы, но не максимум
  const cold = ctx.cell(row({ coin: 'REZ', dayFallPct: 4, pullbackPct: 2 }));
  const risk = ctx.cell(row({ dayFallPct: 12, chg24Pct: -14 }));
  console.log('  ' + name);
  ok(/var\(--blue\)/.test(warm), '  наблюдение выделено голубым');
  ok(warm.includes('rgba(0,180,255,0.06)'), '  и заливкой строки');
  ok(hot.includes('rgba(0,180,255,0.06)'), '  верхняя строка тоже залита');
  ok(hot.includes(String.fromCharCode(9650)), '  у числа есть метка порога');
  ok(!/#00e5a0/.test(cold), '  прочерк не выделяется');
  ok(!cold.includes('rgba(0,180,255,0.06)'), '  и не заливается');
  ok(risk.includes('rgba(255,107,107'), '  риск остаётся красным');
  ok(!risk.includes('rgba(0,180,255,0.06)'), '  заливка наблюдения не перекрывает риск');
  ok(hot.includes('База (падения почти нет)'), '  сравнение с базой есть в подсказке');
  ok(hot.includes('border-left:3px solid var(--blue)') && !cold.includes('border-left:3px'), '  максимум выделен рамкой');
  ok(!hot.includes('#00ffa8') && !hot.includes('rgba(0,255,168'), '  максимум наблюдения не получает цвет покупки');
  ok(hot.includes('максимум'), '  и подписана словом');
  ok(warm.includes('максимум') === false, '  строка ниже такой пометки не получает');
  // Сортировка и подпись живут вне вырезанного куска — проверяем текстом
  ok(/recoveryOrder\(b, j, verdict\(b\), recoveryObservation\(b, j\)\) -\s*\n\s*recoveryOrder\(a, j, verdict\(a\), recoveryObservation\(a, j\)\)/.test(src),
    '  список упорядочен по измеренной частоте');
  ok(!/verdict\(b\)\.tier - verdict\(a\)\.tier/.test(src), '  прежний порядок по уровню отката убран');
  ok(/renderRecoveryLegend\(j\)/.test(src), '  подпись про порог показана');
  ok(/renderRecoveryDeepNote\(ranked, SHOWN, j\)/.test(src), '  ушедшие под черту названы под таблицей');
  ok(/const SHOWN = 8;/.test(src), '  и черта — то же число, что и в таблице');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
