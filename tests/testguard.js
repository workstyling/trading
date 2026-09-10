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
  const ctx = { fs, path, require, __dirname: path.resolve('scripts'), ROOT: path.resolve('.'), console };
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

  // Ошибка зашитых чисел: без неё сравнение однобокое — у сегодняшнего замера
  // ошибка есть, у зашитого будто нет, и любое расхождение значимо
  const { se } = ctx.shippedGrid();
  const keys = Object.keys(se);
  ok(keys.length >= 8, 'ошибка известна почти для всех клеток', keys.join(' '));
  ok(keys.every(k => se[k] > 0.3 && se[k] < 5), 'и она правдоподобной величины',
    Math.min(...Object.values(se)) + '…' + Math.max(...Object.values(se)));
  // Стейблкоин в корзине тянет среднее вниз: у USDT возврат «0%»
  ok(/STABLE\.has\(p\.base_currency\)/.test(rc), 'стейблкоины из корзины исключены');
  // При сотне точек на монету клетки с откатом набирали от одной до восьми
  // монет из полусотни — то есть главные клетки не проверялись вовсе
  ok(/const MIN_PER_COIN = 30/.test(rc), 'порог точек на монету позволяет видеть клетки с откатом');

  // ОШИБКА СЧИТАЕТСЯ ПО МОНЕТАМ, А НЕ ПО ТОЧКАМ.
  //
  // Точки внутри монеты не независимы: окна перекрываются, соседние отстоят
  // на пятнадцать минут. А монеты в одной клетке расходятся страшно — от 39%
  // (BNB) до 84% (DRV) при падении 3-6%. Ошибка по точкам давала ±0.28, по
  // монетам выходит ±1.17, вчетверо больше, и первая же ночная сверка на
  // ошибке по точкам прислала ложную тревогу.
  ok(/sd \/ Math\.sqrt\(parts\.length\)/.test(rc), 'ошибка считается по разбросу между монетами');
  ok(/parts\.length < MIN_COINS/.test(rc), 'по горстке монет выводов не делаем');
  ok(/g\.length < MIN_PER_COIN/.test(rc), 'и по горстке точек внутри монеты тоже');
  // У зашитого числа ошибка тоже есть: считать его точным — значит объявлять
  // значимым любое расхождение
  ok(/Math\.sqrt\(m\.se \* m\.se \+ seWas \* seWas\)/.test(rc), 'сравнивается ошибка РАЗНОСТИ');
  ok(/Math\.abs\(diff\) > 2 \* seDiff && Math\.abs\(diff\) > 3/.test(rc),
    'порог расхождения — и значимость, и величина');

  // КОРЗИНА ТА ЖЕ, ЧТО У ПАНЕЛИ.
  //
  // Прежняя версия мерила всё, что осталось в кеше: один прогон шёл по 30
  // монетам, другой по 68, и разница между ними доходила до двенадцати
  // пунктов в клетке. Это была разница корзин, а не рынка.
  ok(/ENTRY_SCAN_MAX_COINS/.test(rc), 'число монет берётся из кода панели');
  ok(/MIN_VOLUME_USD/.test(rc), 'и порог объёма тоже');
  ok(/for \(const \{ coin \} of basket\)/.test(rc), 'меряются только монеты корзины, а не остатки кеша');
  // Первая сотня из списка биржи в её произвольном порядке — это не «самые
  // ликвидные», а «те, что оказались в начале»: корзина выходила случайной
  ok(/products\/stats/.test(rc) && !/usd\.slice\(0, 140\)/.test(rc),
    'объёмы берутся по всем парам сразу, а не по началу списка');
  // Флаг --se попадал в аргумент «сколько дней»: DAYS = NaN, окно закачки NaN,
  // и все шестьдесят монет «не докачались»
  ok(/find\(a => !a\.startsWith\('-'\)\)/.test(rc), 'флаги не путаются с числом дней');
  ok(/!Number\.isFinite\(DAYS\)/.test(rc), 'и негодное число дней останавливает сразу');

  // Отказ биржи не должен стирать историю: так «исчезли» 23 монеты из 60
  ok(/if \(got\.length > DAYS \* 150\)/.test(rc), 'плохая закачка не затирает хороший кеш');
  ok(/attempt < 4/.test(rc), 'и повторяется с растущим отступом');
  // На длинном прогоне биржа начинает молча ронять часть запросов
  ok(/function paceUp/.test(rc) && /paceUp\(\);/.test(rc), 'темп замедляется, когда биржа спотыкается');
  ok(/повторяю /.test(rc), 'а недокачанные монеты идут вторым заходом');
  // Слепая сверка опаснее её отсутствия: молчит и этим говорит «всё хорошо»
  ok(/if \(!measured\)[\s\S]{0,200}process\.exit\(1\)/.test(rc), 'а если мерить было нечего — это сбой, а не тишина');
  ok(/t0 - c\.t <= 24 \* 3600/.test(rc), 'суточное окно считается по времени, а не по числу свечей');
  ok(/dt > 60/.test(rc), 'часовой возврат — ровно час');
  // Полосы мельче входного порога мерились на другой совокупности (тогда у
  // панели был отбор по баллу) и в панели не показываются. Сравнивать с ними
  // нечестно: на первом же прогоне они дали два ложных расхождения.
  ok(/const shown = g\.lo >= S\.gate/.test(rc), 'полосы вне панели тревогой не считаются');
  ok(/ENTRY_GATE_FALL/.test(rc), 'порог берётся из кода, а не вписан числом');

  ok(/setInterval\(\(\) => recoveryRecheck\(false\)/.test(src), 'сверка запускается сама');
  ok(/Date\.now\(\) - \(st\.at \|\| 0\) < RECHECK_EVERY_H/.test(src),
    'но не на каждый перезапуск — их за день много');
  // Прежде сверка стартовала «через 12 минут после запуска, дальше раз в три
  // часа», и оба таймера обнулялись выкаткой. В день с частыми выкатками она
  // не запускалась НИ РАЗУ — а молчащий сторож неотличим от исправного.
  ok(/setInterval\(\(\) => recoveryRecheck\(false\), 10 \* 60 \* 1000\)/.test(src),
    'работу делает отметка времени, а не таймер от запуска');
  ok(/Date\.now\(\) - \(st\.startedAt \|\| 0\) < 40 \* 60 \* 1000/.test(src),
    'а начатый и убитый выкаткой замер не перезапускается бесконечно');
  ok(/recheck: \(\(\) => \{ const s = recheckStamp\(\)/.test(src),
    'и снаружи видно, когда сверка последний раз доходила до конца');
  ok(/spawn\(process\.execPath, \['scripts\/recheck-recovery\.js'\]/.test(src),
    'считает отдельный процесс, а не торговый цикл');
  ok(/if \(code !== 0\) \{[\s\S]{0,200}sendTelegram/.test(src), 'разошлось — приходит сообщение');
  ok(!/code === 0[\s\S]{0,80}sendTelegram/.test(src), 'а когда всё как было — молчит');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
