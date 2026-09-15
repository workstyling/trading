// Run the actual renderers from both layouts against current, sparse and missing observations.
const fs = require('fs'), vm = require('vm');
const view = require('../public/js/recovery-journal');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const now = Date.now();
const scan = { recoveryMeasuredAt: '2026-09-09', recheck: {
  current: true, code: 1, at: now, report: { version: 2, status: 'drift',
    referenceDate: '2026-09-09', from: now - 3 * 86400000, to: now - 300000, missingCoins: [],
    cells: [
      { lo: 3, deep: false, actual: 54.214, se: 2.6, coins: 29 },
      { lo: 3, deep: true, actual: 72.36, se: 3, coins: 14 },
      { lo: 10, deep: true, thin: true, coins: 7 },
    ],
  },
} };
function renderers(source, data = scan) {
  const start = source.indexOf('        const swingMark = (x) => {');
  const end = source.indexOf('        box.innerHTML = head + renderRecoveryStatus', start);
  const ctx = { ...view, j: data, gate: { fall: 3, spread: 0.3 }, good: [], price: x => String(x) };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, end) + ';this.verdict = verdict; this.cell = cell;', ctx);
  return ctx;
}
const row = over => ({ coin: 'REZ', price: 1, dayFallPct: 4, spreadPct: 0.1,
  pullbackPct: 2, chg24Pct: 4.25, inListMin: 5, recovery: { hour: 89 }, ...over });
for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  console.log('\n' + name);
  const source = read(file), renderer = renderers(source), f = renderer.verdict;
  ok(f(row({})).label === 'наблюдать', 'измеренная частота не даёт разрешения брать');
  ok(f(row({})).tier === 3, 'условия глубокого отката сохраняют свой уровень');
  ok(f(row({ pullbackPct: 0.9 })).tier === 2, 'мелкий откат остаётся отдельным уровнем');
  ok(f(row({ pullbackPct: 1.5 })).tier === 3 && f(row({ pullbackPct: 1.49 })).tier === 2, 'граница отката 1.5%');
  ok(f(row({ chg24Pct: 10 })).label === 'риск' && f(row({ chg24Pct: -10 })).label === 'риск', 'суточный риск в обе стороны');
  ok(f(row({ chg24Pct: 9.9 })).label === 'наблюдать', 'ниже порога риск не выдумывается');
  for (const over of [{ spreadPct: 0.9 }, { spreadPct: null }, { spreadPct: -0.1 }, { dayFallPct: 1.2 }, { chg24Pct: null }, { pullbackPct: null }]) {
    ok(f(row(over)).tier === 0, 'неполные данные или непройденные условия блокируют кандидата');
  }
  ok(f(row({ dayFallPct: 16.35 })).label === 'нет оценки', 'малой выборке не подставляются старые 89%');
  ok(renderers(source, { ...scan, recheck: null }).verdict(row({})).label === 'нет оценки', 'нет свежей проверки — нет оценки');
  const html = renderer.cell(row({ pullbackPct: 0.9 })), visible = html.replace(/<[^>]+>/g, ' ');
  ok(visible.includes('54.2%') && !visible.includes('89%'), 'в строке свежая частота нужной группы');
  ok(visible.includes('+4.25%'), 'суточный ход показан со знаком');
  const sparseHtml = renderer.cell(row({ dayFallPct: 16.35 }));
  const columns = [...sparseHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, ' '));
  ok(columns[3].trim() === '+4.25%' && columns[0].includes('от пика −16.35%'), 'суточный ход и падение от пика показаны отдельно');
  ok(renderer.cell(row({ dayFallPct: 16.35 })).includes('Падение от суточного пика: 16.35%'), 'глубина от пика сохранена в подсказке');
  ok(!html.includes('rgba(0,229,160,0.16)'), 'нет зелёной заливки разрешения');
  ok(html.includes('data-bookshare="REZ"'), 'ячейка позиции сохраняется');
}

console.log('\nСервер режет список уже по уровню, а не по одному возврату');
{
  // Наружу уходит пятнадцать строк. Пока сортировка шла по возврату, в
  // падающем рынке все пятнадцать занимали монеты с 89% и пометкой обвала, а
  // единственная «брать» с 87% оказывалась шестнадцатой и до экрана не
  // доезжала. Панель переупорядочивает полученное, но отрезанное не вернёт.
  const src = read('server.js');
  const i = src.indexOf('    const swing = r => r.chg24Pct != null');
  const j = src.indexOf('fall(b) - fall(a));', i) + 20;
  ok(i > 0 && j > i, 'сортировка с уровнем найдена');
  const head = src.slice(src.indexOf('const recHour = r =>'), i);

  const ctx = {
    Number, Math,
    entryPasses: (r) => r.dayFallPct >= 3 && r.spreadPct != null && r.spreadPct <= 0.30,
  };
  vm.createContext(ctx);
  vm.runInContext('var rows = [];\n' + head + src.slice(i, j) + ';this.sort = (a) => { rows = a; ' +
    src.slice(src.indexOf('rows.sort((a, b) =>', i), j) + ' return rows; };', ctx);

  const r = (coin, o) => ({ coin, dayFallPct: 12, spreadPct: 0.1, pullbackPct: 0.5,
    chg24Pct: -4, recovery: { hour: 78 }, ...o });
  const out = ctx.sort([
    r('CRASH1', { chg24Pct: -22, pullbackPct: 5, recovery: { hour: 89 } }),
    r('CRASH2', { chg24Pct: -14, pullbackPct: 3, recovery: { hour: 89 } }),
    r('PUMP1', { chg24Pct: 44, pullbackPct: 8, recovery: { hour: 89 } }),
    r('TAKE', { dayFallPct: 6.7, pullbackPct: 2.1, chg24Pct: -4.7, recovery: { hour: 87 } }),
    r('MAYBE', { pullbackPct: 0.4, recovery: { hour: 78 } }),
    r('OUT', { spreadPct: 0.9, pullbackPct: 9, recovery: { hour: 89 } }),
  ]).map(x => x.coin);

  ok(out[0] === 'TAKE', 'спокойная монета с взятым порогом отката идёт первой', out.join(' '));
  ok(out.indexOf('MAYBE') < out.indexOf('CRASH1'), '«можно» выше «риска», хотя возврат у него ниже');
  ok(out.indexOf('CRASH1') < out.indexOf('OUT'), 'а не прошедшие вход — в самом конце');
  ok(out.indexOf('CRASH1') < out.indexOf('CRASH2'), 'внутри уровня порядок прежний — по возврату и откату');
  ok(/tier\(b\) - tier\(a\) \|\|/.test(src), 'уровень — старший ключ сортировки');
}

console.log('\nКолонка «вход» уступила место ответу');
{
  const d = read('public/index.html');
  const head = d.slice(d.indexOf('const head2 ='), d.indexOf('const verdict'));
  ok(/>статус \/ спред<\/th>/.test(head), 'десктоп: статус и текущий спред');
  ok(!/>вход<\/th>/.test(head), 'а колонки «вход» больше нет — балл возврат не предсказывает');
  ok(/>цель 1ч<\/th>/.test(head) && /откат<\/th>/.test(head), 'цель за час и откат на месте');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
