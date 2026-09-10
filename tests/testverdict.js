// Явный ответ на вопрос «брать?» — и он собран только из измеренного.
//
// Просьба была прямая: показывать, какие монеты можно покупать. Раньше панель
// подсвечивала зелёным всё, что прошло порог входа (падение 3%+, спред до
// 0.30%), а это почти весь список — и выбирать по такой подсветке было
// нельзя.
//
// В условие входят три вещи, у каждой число за спиной:
//   порог входа — падение от суточного максимума 3%+, спред до 0.30%;
//   откат от 1.5% — внутри любой глубины это +11-18 пунктов к доле возврата;
//   ход за сутки в пределах ±10% — за чертой цена уходит ниже −3% за час в
//     20-24% случаев против 2.7% у спокойных.
//
// Чего в условии НЕТ и почему:
//   балл ВХОД — ровный от 1 до 100, вперёд себя не подтвердил;
//   сколько монета висит в списке — померено, разницы почти нет: дошедших
//     75% у свежих против 70-74% у висящих сутками, а с откатом от 1.5%
//     и вовсе 85% против 87%.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

const grabVerdict = (src) => {
  const i = src.indexOf('const verdict = (x) => {');
  if (i < 0) return null;
  const j = src.indexOf('\n        const cell = (x)', i);
  const ctx = {
    Math, String,
    entryPassesUi: (x, g) => x.dayFallPct >= g.fallPct && x.spreadPct != null && x.spreadPct <= g.spreadPct,
    gate: { fallPct: 3, spreadPct: 0.3 },
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(i, j) + ';this.verdict = verdict;', ctx);
  return ctx.verdict;
};

const row = (over) => ({ dayFallPct: 12, spreadPct: 0.1, pullbackPct: 2.1, chg24Pct: -4,
  inListMin: 5, recovery: { hour: 89 }, ...over });

for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  console.log('\n' + name);
  const src = read(file);
  const f = grabVerdict(src);
  ok(!!f, 'ответ «брать?» есть');
  if (!f) continue;

  ok(f(row({})).label === 'брать', 'всё измеренное за — «брать»', f(row({})).label);
  ok(f(row({})).tier === 3, 'и это высший уровень');

  ok(f(row({ pullbackPct: 0.9, recovery: { hour: 78 } })).label === 'можно',
    'откат не дотянул до 1.5% — «можно», а не «брать»');
  ok(f(row({ pullbackPct: 1.5 })).label === 'брать', 'ровно 1.5% — уже порог взят');
  ok(f(row({ pullbackPct: 1.49 })).label === 'можно', 'а чуть ниже — ещё нет');

  ok(f(row({ chg24Pct: 44 })).label === 'риск', 'разгон за сутки — «риск», даже с глубоким откатом');
  ok(f(row({ chg24Pct: -23 })).label === 'риск', 'обвал за сутки — тоже');
  ok(f(row({ chg24Pct: 9.9 })).label === 'брать', 'порог риска ровно там, где мерили: ±10%');
  ok(f(row({ chg24Pct: 10 })).label === 'риск', 'и на самой черте уже риск');

  ok(f(row({ spreadPct: 0.9 })).tier === 0, 'не прошла порог входа — вообще не кандидат');
  ok(f(row({ dayFallPct: 1.2 })).tier === 0, 'мелкое падение тоже');

  // Свежесть в условие не входит: это померено, а не забыто
  ok(f(row({ inListMin: 4000 })).label === 'брать',
    'висящая сутками монета не теряет «брать» — разницы в исходе нет');

  // Порядок: сперва те, что брать
  ok(/sort\(\(a, b\) => verdict\(b\)\.tier - verdict\(a\)\.tier\)/.test(src),
    'список выстроен по уровню: сперва «брать»');

  // Числа в подсказках должны быть измеренные, а не круглые на глаз
  ok(/11-18 пунктов/.test(src), 'сказано, сколько даёт откат');
  ok(/20-24% случаев против 2\.7%/.test(src), 'и чем платят за разгон или обвал');
  ok(/70-74% против 75%/.test(src), 'и что висение в списке почти ничего не меняет');
  // Уровень не должен читаться как обещание прибыли
  ok(/менее убыточной, а не прибыльной/.test(src), 'и что прибыли ни один уровень не обещает');
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
  ok(/>брать\?<\/th>/.test(head), 'десктоп: в шапке стоит «брать?»');
  ok(!/>вход<\/th>/.test(head), 'а колонки «вход» больше нет — балл возврат не предсказывает');
  ok(/>возврат<\/th>/.test(head) && /откат<\/th>/.test(head), 'возврат и откат на месте');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
