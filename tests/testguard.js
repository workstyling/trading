// Обвязка, на которую опирается всё остальное: ворота выкатки, хвост журнала
// и сверка сетки возврата.
//
// Раньше выкатка была «git pull и рестарт» — один раз так уехал код с пятью
// красными проверками. Логов с сервера не было вовсе: причину бага со сторожем
// безубытка пришлось предполагать по состоянию, а не читать. А таблица
// возврата — фотография с датой, которая может разойтись с рынком молча.
const fs = require('fs'), vm = require('vm'), path = require('path');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = read('server.js');

console.log('\nВорота выкатки');
{
  const dep = src.slice(src.indexOf("app.post('/api/deploy'"));
  const head = dep.slice(0, dep.indexOf("app.get('/api/score-stats'"));
  ok(/git rev-parse HEAD/.test(head), 'запоминаем, где были до pull');
  ok(/spawnSync\(process\.execPath, \['tests\/run\.js'\]/.test(head), 'набор проверок гоняется прямо в выкатке');
  ok(head.indexOf("['tests/run.js']") < head.indexOf('process.exit(0)'),
    'и ДО перезапуска — иначе проверять уже поздно');
  ok(/git reset --hard ' \+ head0/.test(head), 'красный откатывает код обратно');
  ok(/status\(409\)/.test(head), 'и выкатка отвечает отказом, а не «успешно»');
  ok(/existsSync\(path\.join\(__dirname, 'tests', 'run\.js'\)\)/.test(head),
    'первая выкатка, которая привозит сами проверки, не блокирует себя');
  // Если ворота молча пропускают всё, они хуже отсутствия: создают уверенность
  ok(/rolledBackTo/.test(head), 'в ответе сказано, куда откатились');
  // Сломаться может и сам набор. Без запасного выхода чинить его было бы
  // нечем: другого канала доставки кода на машину нет.
  ok(/req\.query\.skiptests/.test(head), 'есть запасной выход на случай сломанного набора');
  ok(/if \(r\.error\)/.test(head), 'а «не запустился» и «красный» — разные случаи');
}

console.log('\nХвост журнала');
{
  ok(/const logRing = \[\]/.test(src), 'кольцо есть');
  ok(src.indexOf('const logRing') < src.indexOf('process.on(\'uncaughtException\''),
    'заведено раньше первой возможной ошибки');
  ok(/for \(const level of \['log', 'warn', 'error'\]\)/.test(src), 'перехвачены все три уровня');
  ok(/orig\(\.\.\.a\)/.test(src), 'и в обычный вывод строки по-прежнему идут');

  // Кольцо: проверяем поведение, а не текст
  const ctx = { Date, JSON, String, Error, console: { log: () => { }, warn: () => { }, error: () => { } } };
  vm.createContext(ctx);
  const i = src.indexOf('const LOG_RING_MAX');
  const j = src.indexOf('\n}\n', src.indexOf('function logRingPush')) + 2;
  vm.runInContext(src.slice(i, j) + ';this.logRing = logRing; this.push = logRingPush;', ctx);
  for (let k = 0; k < 700; k++) ctx.push('log', ['строка ' + k]);
  ok(ctx.logRing.length === 600, 'кольцо не растёт бесконечно', String(ctx.logRing.length));
  ok(ctx.logRing[0].text === 'строка 100', 'старое вытесняется, а не новое', ctx.logRing[0].text);
  ctx.push('error', ['x'.repeat(9000)]);
  ok(ctx.logRing[ctx.logRing.length - 1].text.length <= 4001,
    'одна длинная строка не съедает кольцо', String(ctx.logRing[ctx.logRing.length - 1].text.length));
  ctx.push('error', [new Error('внутри ошибка')]);
  ok(/внутри ошибка/.test(ctx.logRing[ctx.logRing.length - 1].text), 'ошибка пишется текстом, а не [object]');
  const circular = {}; circular.self = circular;
  let threw = false;
  try { ctx.push('log', [circular]); } catch { threw = true; }
  ok(!threw, 'закольцованный объект не роняет сервер');

  const ep = src.slice(src.indexOf("app.get('/api/logs'"), src.indexOf("app.post('/api/deploy'"));
  ok(/constantTimeTokenEquals/.test(ep), 'без ключа журнал не отдаётся');
  ok(/status\(403\)/.test(ep), 'и отказ явный');
  ok(/req\.query\.level/.test(ep) && /req\.query\.q/.test(ep), 'есть отбор по уровню и по тексту');
  // Пустой ответ не должен читаться как «всё тихо», если кольцо просто новое
  ok(/since:/.test(ep), 'видно, с какого момента копится');
}

console.log('\nСверка сетки возврата');
{
  const rc = read(path.join('scripts', 'recheck-recovery.js'));
  // Разбор таблицы из кода — то место, где сверка может незаметно ослепнуть:
  // вбитая копия чисел однажды уже отстала на целое измерение.
  const ctx = { fs, path, require, __dirname: path.resolve('scripts'), console };
  vm.createContext(ctx);
  vm.runInContext(rc.slice(rc.indexOf('function shippedGrid'),
    rc.indexOf('\n}\n', rc.indexOf('function shippedGrid')) + 2) + ';this.shippedGrid = shippedGrid;', ctx);
  const { grid, at, n } = ctx.shippedGrid();

  // Сверяем разобранное с настоящей функцией: числа обязаны совпасть
  const rctx = {};
  vm.createContext(rctx);
  vm.runInContext(src.match(/function recoveryOdds[\s\S]*?\n}/)[0] + ';this.f = recoveryOdds;', rctx);
  ok(grid.length === 5, 'разобраны все полосы глубины', String(grid.length));
  let same = true;
  for (const g of grid) {
    const probe = g.lo + 0.5;
    if (rctx.f(probe, 0.1).hour !== g.shallow) same = false;
    if (g.deep != null && rctx.f(probe, 2).hour !== g.deep) same = false;
  }
  ok(same, 'разобранные числа совпадают с тем, что функция реально возвращает',
    JSON.stringify(grid.map(g => g.lo + ':' + g.shallow + '/' + g.deep)));
  ok(at && /^\d{4}-\d{2}-\d{2}$/.test(at), 'дата замера прочитана', String(at));
  ok(n > 1000, 'и размер выборки', String(n));

  // Расхождением считается выход за две ошибки И больше трёх пунктов: на
  // шестидесяти тысячах точек значимой становится и разница в полтора пункта
  ok(/Math\.abs\(diff\) > 2 \* m\.se && Math\.abs\(diff\) > 3/.test(rc),
    'порог расхождения — и значимость, и величина');
  ok(/if \(list\.length < 200\) return null/.test(rc), 'по горстке точек выводов не делаем');
  // Слепая сверка опаснее её отсутствия: молчит и этим говорит «всё хорошо»
  ok(/if \(!measured\)[\s\S]{0,200}process\.exit\(1\)/.test(rc), 'а если мерить было нечего — это сбой, а не тишина');
  ok(/t0 - c\.t <= 24 \* 3600/.test(rc), 'суточное окно считается по времени, а не по числу свечей');
  ok(/dt > 60/.test(rc), 'часовой возврат — ровно час');
  // Полосы мельче входного порога мерились на другой совокупности (тогда у
  // панели был отбор по баллу) и в панели не показываются. Сравнивать с ними
  // нечестно: на первом же прогоне они дали два ложных расхождения.
  ok(/const shown = g\.lo >= gate/.test(rc), 'полосы вне панели тревогой не считаются');
  ok(/ENTRY_GATE_FALL/.test(rc), 'порог берётся из кода, а не вписан числом');

  ok(/setInterval\(\(\) => recoveryRecheck\(false\)/.test(src), 'сверка запускается сама');
  ok(/Date\.now\(\) - last < RECHECK_EVERY_H/.test(src), 'но не на каждый перезапуск — их за день много');
  ok(/spawn\(process\.execPath, \['scripts\/recheck-recovery\.js'\]/.test(src),
    'считает отдельный процесс, а не торговый цикл');
  ok(/if \(code !== 0\) \{[\s\S]{0,200}sendTelegram/.test(src), 'разошлось — приходит сообщение');
  ok(!/code === 0[\s\S]{0,80}sendTelegram/.test(src), 'а когда всё как было — молчит');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
