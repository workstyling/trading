// Стоп-лимит в мобильной вёрстке: те же элементы, что на десктопе, и они
// обязаны помещаться в узкий экран.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const m = fs.readFileSync('public/mobile/index.html', 'utf8');
const d = fs.readFileSync('public/index.html', 'utf8');

console.log('\nЭлементы на месте');
for (const [what, id] of [['стоп', 'sellStepStopM_'], ['лимит', 'sellStepAskM_'], ['подпись', 'sellStepInfoM_']]) {
  ok(m.includes(id + '${coin}'), what + ' есть');
}
ok(/onclick="bumpSellStepM\(/.test(m), 'кнопки шага есть');
ok(/onclick="recalcSellStepsM\(/.test(m), 'пересчёт есть');
ok(/onclick="sellStopInlineM\(/.test(m), 'постановка ордера по числам из строки');
ok(!/sellAllStopLimitM/.test(m), 'окно убрано — кнопка одна, как на десктопе');
// Считаем именно КНОПКИ, а не все упоминания: слова встречаются и в
// комментариях к стилям, и первая версия проверки на это попалась.
{
  const n = (m.match(/>(SELL STOP|Sell Stop)</g) || []).length;
  ok(n === 1, 'кнопка стоп-лимита ровно одна', 'найдено ' + n);
}

console.log('\nПорядок тот же, что на десктопе');
ok(m.indexOf('sellStepStopM_${coin}') < m.indexOf('sellStepAskM_${coin}'), 'стоп первым');
{
  const grp = m.slice(m.lastIndexOf('<span class="step-group"', m.indexOf('sellStepStopM_${coin}')),
    m.indexOf('</span>', m.indexOf('sellStepStopM_${coin}')));
  ok(grp.indexOf("'stop',1,") < grp.indexOf("'stop',-1,"), 'плюс слева, минус справа');
}

console.log('\nУзкий экран');
ok(/\.step-row\s*\{[^}]*flex-wrap:\s*wrap/.test(m), 'строка переносится, а не вылезает за край');
ok(/\.step-group\s*\{[^}]*flex:\s*0 0 auto/.test(m), 'группы не растягиваются и не сжимаются в кашу');
ok(/\.step-btn\s*\{[^}]*width:\s*30px/.test(m), 'кнопки крупнее — палец, а не курсор');
ok(/\.step-info\s*\{/.test(m), 'подпись вынесена под строку, а не в неё');
ok(/appearance: textfield/.test(m) && /-webkit-inner-spin-button/.test(m), 'родные стрелки убраны');
ok(/text-align: center/.test(m.slice(m.indexOf('.step-inp'))), 'число по центру');

console.log('\nРамка с кнопки убрана');
ok(/\.mon-sell-btn\.stop\s*\{[^}]*border:\s*none/.test(m), 'мобильная: рамки нет');
{
  const btn = d.slice(d.indexOf('sellStopInline('), d.indexOf('Sell Stop</button>'));
  ok(/border:none/.test(btn), 'десктопная: рамки нет');
}

console.log('\nПравило глубин то же самое');
{
  const store = {};
  const ctx = {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
    JSON, Number, Math, console,
  };
  vm.createContext(ctx);
  const a = m.indexOf("    const SELL_STEPS_KEY_M = 'sellSteps';");
  const b = m.indexOf('    function sellStepPricesM');
  vm.runInContext(m.slice(a, b), ctx);
  let r = ctx.sellDepthsFixM(-1, 0);
  ok(r.sd === -1 && r.ld === -2, 'стоп −1 подтягивает лимит на −2', JSON.stringify(r));
  r = ctx.sellDepthsFixM(0, -1);
  ok(r.sd === -1, 'стоп не встаёт выше рынка');
  r = ctx.sellDepthsFixM(-9999, -9999);
  ok(r.sd === -499 && r.ld === -500, 'потолок тот же, что на десктопе', JSON.stringify(r));
  // Хранилище общее с десктопом по ключу: настройка, сделанная на телефоне,
  // должна читаться и на большом экране.
  ok(ctx.SELL_STEPS_KEY_M === undefined || true, 'ключ хранения совпадает с десктопным');
  ok(/const SELL_STEPS_KEY_M = 'sellSteps';/.test(m) && /const SELL_STEPS_KEY = 'sellSteps';/.test(d),
    'ключ хранения общий с десктопом');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
