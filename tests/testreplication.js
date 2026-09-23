// Повторная предрегистрированная проверка на свежих данных.
//
// Проверка правила fall3 закончилась «преимущество не подтверждено» на 139
// исходах, и печать удержала вердикт. После неё выборка копилась дальше, и к
// 231 исходу разница выросла до +0.568 ±0.165 — 3.4 ошибки. Засчитать это
// нельзя: смотреть в ту же выборку, пока не понравится результат, — ровно та
// ошибка, от которой защищает печать.
//
// Законный путь один: записать правила новой проверки ДО прихода данных и
// считать в ней только то, чего при записи ещё никто не видел. Главное, что
// здесь проверяется, — что ни одна из уже увиденных сделок в повтор не
// попадает.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');
const J = require('../src/recovery/journal');
const R = require('../public/js/recovery-journal');

const SINCE = Date.parse('2026-09-23T10:00:00.000Z');
const LAST_SEEN = Date.parse('2026-09-23T09:15:04.000Z');   // последняя сделка при записи правил
const HOUR = 3600000;

// Настоящие функции из server.js
function load(entryRule = 'fall3', decisions = {}) {
  const logs = [];
  let saved = 0;
  const ctx = {
    Date, Number, JSON, Math, Object,
    ENTRY_RULE: entryRule,
    entryJournal: J,
    entryPaper: { decisions },
    saveEntryPaper() { saved++; },
    console: { log: m => logs.push(m) },
  };
  vm.createContext(ctx);
  const i = src.indexOf('const ENTRY_REPLICATION = {');
  const j = src.indexOf('// Открываем сделки по монетам, которые только что вошли в список');
  vm.runInContext(src.slice(i, j) + ';this.R = ENTRY_REPLICATION; this.decide = replicationDecision;', ctx);
  ctx.logs = logs;
  ctx.saved = () => saved;
  return ctx;
}

// Сделки с шумом: без разброса ошибка разности нулевая, и «значимо» всё.
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
const trades = (n, m60, noise, start, control = false) => {
  seed = control ? 7 : 3;
  return Array.from({ length: n }, (_, i) => ({
    outcomeVersion: 4, m60: m60 + rnd() * noise, coin: 'C' + (i % 15),
    ...(control ? { cv: 2 } : {}), at: start + (i % 40) * HOUR,
  }));
};

console.log('\nПравила записаны до данных');
{
  const c = load();
  ok(c.R.id === 'fall3-r1', 'у повтора своё имя — печать не смешается с исходной');
  ok(c.R.rule === 'fall3', 'и он про то же правило');
  ok(c.R.since === SINCE, 'точка старта зашита в код', new Date(c.R.since).toISOString());
  ok(c.R.since > LAST_SEEN, 'и она позже последней сделки, которую я видел',
    ((c.R.since - LAST_SEEN) / 60000).toFixed(0) + ' мин запаса');
  ok(Date.parse(c.R.registeredAt) < c.R.since, 'правила записаны раньше точки старта');
}

console.log('\nУже увиденные сделки в повтор не попадают');
{
  // Та самая выборка, на которой разница выросла до 3.4 ошибки: огромный
  // плюс, всё до точки старта. Повтор обязан её не заметить.
  const seen = trades(231, 5, 0.6, LAST_SEEN - 40 * HOUR);
  const seenCtrl = trades(231, 0, 0.6, LAST_SEEN - 40 * HOUR, true);
  const c = load();
  const d = c.decide(seen, seenCtrl);
  ok(d.haveN === 0, 'из 231 увиденного в повтор не попало ни одной', 'исходов ' + d.haveN);
  ok(d.state === 'ждём', 'и повтор честно ждёт', d.state);
  ok(!c.saved(), 'печатать нечего');

  // Сделка ровно в точке старта уже считается, на миллисекунду раньше — нет
  const edge = [{ outcomeVersion: 4, m60: 1, coin: 'X', at: SINCE },
                { outcomeVersion: 4, m60: 1, coin: 'Y', at: SINCE - 1 }];
  const d2 = load().decide(edge, []);
  ok(d2.recordedN === 1, 'граница строгая: с точки старта — да, раньше — нет', 'записано ' + d2.recordedN);
  // Сделка без времени — неизвестно когда, значит не засчитывается
  const d3 = load().decide([{ outcomeVersion: 4, m60: 1, coin: 'Z' }], []);
  ok(d3.recordedN === 0, 'сделка без времени в повтор не идёт');
}

console.log('\nСвежие данные считаются по тем же правилам');
{
  const fresh = trades(200, 0.10, 6, SINCE);
  const freshCtrl = trades(200, 0.05, 6, SINCE, true);
  const c = load();
  const d = c.decide(fresh, freshCtrl);
  ok(d.needN === 40 && d.giveUpN === 120, 'пороги те же, что у исходной проверки',
    d.needN + '/' + d.giveUpN);
  ok(d.state === 'преимущество не подтверждено', 'шум без разницы — сдача', d.state);
  ok(c.saved() === 1, 'вердикт запечатан сразу');
  ok(c.entryPaper.decisions['fall3-r1'], 'под своим именем');
  ok(c.entryPaper.decisions['fall3-r1'].since === SINCE, 'и с точкой старта');
  ok(c.logs.some(m => /повтор fall3-r1 решён/.test(m)), 'решение видно в логе сервера');
}

console.log('\nРанняя значимость — законный ответ');
{
  const c = load();
  const d = c.decide(trades(60, 3, 0.6, SINCE), trades(60, 0, 0.6, SINCE, true));
  ok(d.haveN < d.giveUpN, 'исходов меньше порога сдачи', d.haveN + '/' + d.giveUpN);
  ok(d.state === 'лучше контроля', 'значимость до сдачи даёт содержательный ответ', d.state);
  ok(c.saved() === 1, 'и он тоже запечатан');
}

console.log('\nПечать повтора держит так же, как исходная');
{
  const sealed = { state: 'преимущество не подтверждено', at: 1, n: 120, diff: 0.1, se: 0.2 };
  const c = load('fall3', { 'fall3-r1': sealed });
  const d = c.decide(trades(400, 5, 0.6, SINCE), trades(400, 0, 0.6, SINCE, true));
  ok(d.state === 'преимущество не подтверждено', 'позднейшая значимость вердикт не меняет', d.state);
  ok(d.stateNow === 'лучше контроля', 'но пересчёт показан отдельно', d.stateNow);
  ok(!c.saved(), 'повторно не печатается');
}

console.log('\nИсходная проверка не тронута');
{
  const sealed = { state: 'преимущество не подтверждено', at: 1, n: 139, diff: 0.398, se: 0.28 };
  const c = load('fall3', { fall3: sealed });
  c.decide(trades(200, 0.1, 6, SINCE), trades(200, 0.05, 6, SINCE, true));
  ok(c.entryPaper.decisions.fall3 === sealed, 'печать исходной проверки осталась как была');
  ok(/decision: entryDecision\(take, ctrl\)/.test(src), 'исходное решение по-прежнему в ответе');
  ok(/replication: replicationDecision\(take, ctrl\)/.test(src), 'повтор — отдельным полем рядом');
}

console.log('\nСменилось правило — повтор молчит');
{
  // Повтор проверял fall3. Если правило входа сменят, выдавать его вердикт за
  // вердикт нового правила нельзя.
  const c = load('other');
  ok(c.decide(trades(200, 5, 0.6, SINCE), trades(200, 0, 0.6, SINCE, true)) === null,
    'для чужого правила повтор не считается');
  ok(!c.saved(), 'и ничего не печатает');
}

console.log('\nПовтор виден в журнале');
{
  const base = { comparison: null, overall: { n: 0 }, open: 0,
    decision: { state: 'преимущество не подтверждено', haveN: 231, needN: 40, haveHours: 80, needHours: 25, why: 'x' } };
  const html = R.renderEntryJournal({ ...base,
    replication: { id: 'fall3-r1', since: SINCE, state: 'ждём', haveN: 3, needN: 40, reason: 'проверка', why: 'мало' } });
  ok(/Повтор на свежих данных: ждём/.test(html), 'строка повтора есть');
  ok(/3\/40 исходов с 2026-09-23 10:00 UTC/.test(html), 'с числом исходов и точкой старта');
  ok(/Глубокий откат: преимущество не подтверждено/.test(html), 'исходный вердикт рядом, не подменён');
  ok(!/Повтор/.test(R.renderEntryJournal({ ...base, replication: null })), 'нет повтора — нет строки');
  // Обе вёрстки грузят один и тот же файл журнала
  for (const f of ['public/index.html', 'public/mobile/index.html']) {
    ok(fs.readFileSync(f, 'utf8').includes('<script src="/js/recovery-journal.js"></script>'),
      f + ' показывает ту же строку');
  }
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
