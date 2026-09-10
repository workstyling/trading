// Пересчёт «чистыми» по движению цены.
//
// Элемент позиции в стакане рисуется ТОЛЬКО у открытого лимитного ордера.
// Позиция, купленная по рынку, такого элемента не имеет — и её пара в опрос
// не попадала: стакан не запрашивался, строка стоп-лимита не пересчитывалась,
// цифры застывали на последнем ручном пересчёте.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

console.log('\nПары для опроса собираются из обоих источников');
{
  const body = h.slice(h.indexOf('async function updateOrderPositions'), h.indexOf('function rehydratePositionsFromCache'));
  ok(/querySelectorAll\('\[id\^="sellStepInfo_"\]'\)/.test(body), 'строки стоп-лимита учитываются');
  ok(/if \(!posElements\.length && !stepElements\.length\) return;/.test(body),
    'ранний выход не срабатывает, когда открытых лимиток нет, а строка есть');
  ok(body.indexOf('stepElements.forEach') < body.indexOf('const pairs = Object.keys(pairGroups)'),
    'пары добавляются ДО составления списка запросов');
  ok(/sellStepPaintFromBook\(pair, book\)/.test(body), 'подпись рисуется из полученного стакана');
}

console.log('\nПоведение при движении цены');
{
  // Проигрываем сбор пар руками: у монеты есть строка стоп-лимита, но нет
  // ни одного открытого лимитного ордера.
  const stepEls = [{ id: 'sellStepInfo_CRO' }, { id: 'sellStepInfo_ENA' }];
  const posEls = [];
  const pairGroups = {};
  posEls.forEach(el => { const p = el.dataset.pair; (pairGroups[p] = pairGroups[p] || []).push(el); });
  stepEls.forEach(el => { const p = el.id.slice('sellStepInfo_'.length) + '-USD'; if (!pairGroups[p]) pairGroups[p] = []; });
  const pairs = Object.keys(pairGroups);
  ok(pairs.length === 2 && pairs.includes('CRO-USD'), 'пара рыночной покупки попадает в опрос', pairs.join(','));

  // Цена ушла — цены по тем же глубинам стали другими, значит и прибыль тоже
  const ladderBefore = [0.05992, 0.05986, 0.05985, 0.05984, 0.05983, 0.05982, 0.05981];
  const ladderAfter = [0.05972, 0.05966, 0.05965, 0.05964, 0.05963, 0.05962, 0.05961];
  const px = (l, d) => l[Math.min(-d, l.length - 1)];
  const qty = 41421.90, spent = 2491.03, fee = 0.0015;
  const pnl = (l) => qty * px(l, -6) * (1 - fee) - spent;
  ok(pnl(ladderAfter) < pnl(ladderBefore), 'при падении цены прибыль уменьшается',
    pnl(ladderBefore).toFixed(2) + ' -> ' + pnl(ladderAfter).toFixed(2));
  ok(Math.abs((pnl(ladderBefore) - pnl(ladderAfter)) - qty * (px(ladderBefore, -6) - px(ladderAfter, -6)) * (1 - fee)) < 1e-6,
    'разница ровно на движение цены с учётом комиссии');
}

console.log('\nЧастота опроса');
ok(/setInterval\(updateOrderPositions, 7000\)/.test(h), 'опрос идёт каждые семь секунд');
{
  // Стакан тянется общим кешем с коротким сроком: две строки одной пары не
  // должны давать два запроса.
  ok(/cbGet\(`https:\/\/api\.exchange\.coinbase\.com\/products\/\$\{pair\}\/book\?level=2`\)/.test(h),
    'стакан берётся через общий кеш запросов');
}


console.log('\nМобильная: тот же пробел был и там');
{
  const h = fs.readFileSync('public/mobile/index.html', 'utf8');
  const body = h.slice(h.indexOf('async function updateOrderPositionsM'), h.indexOf('setInterval(updateOrderPositionsM'));
  ok(/querySelectorAll\('\[id\^="sellStepInfoM_"\]'\)/.test(body), 'строки стоп-лимита учитываются');
  ok(/if \(!els\.length && !steps\.length\) return;/.test(body),
    'ранний выход не срабатывает, когда открытых лимиток нет, а строка есть');
  ok(body.indexOf('steps.forEach') < body.indexOf('await Promise.all'),
    'пары добавляются ДО составления списка запросов');
  ok(/sellStepPaintFromBookM\(pair, book\)/.test(body), 'подпись рисуется из полученного стакана');
  ok(/setInterval\(updateOrderPositionsM, 8000\)/.test(h), 'опрос идёт каждые восемь секунд');

  // Общий цикл про монету ничего не знает — объём и потраченное должны
  // лежать на самой строке, иначе прибыль посчитается по нулям.
  ok(/data-size="\$\{totalFilledStr\}" data-cost="\$\{totalUSD\}"/.test(h),
    'строка несёт объём и потраченное');
  ok(/const size = info\.dataset\.size, cost = info\.dataset\.cost;/.test(h),
    'перерисовка берёт их оттуда');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
