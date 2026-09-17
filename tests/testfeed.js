// Лента скана: то, что по свечам задним числом не восстановить.
//
// Ценовые признаки перебраны, ни один не пережил проверку на второй половине
// периода. Непроверенным осталось то, чего в свечах нет вовсе: спред, стакан,
// давность появления монеты в списке. Биржа отдаёт историю цен, но не историю
// стакана — значит, писать надо вперёд, и каждый день промедления это день, на
// который позже придёт ответ.
//
// Цена ошибки здесь тихая: испорченная лента выглядит как полная, и понятно
// это станет через неделю, когда по ней уже что-то посчитают.
const fs = require('fs'), vm = require('vm'), os = require('os'), path = require('path');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');

function load(name) {
  const dir = path.join(os.tmpdir(), 'feedtest-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const logs = [];
  const ctx = { fs, path, __dirname: dir, Number, Math, JSON, String, Buffer,
    console: { log: m => logs.push(m), error: m => logs.push('ОШИБКА ' + m) } };
  vm.createContext(ctx);
  const i = src.indexOf('const FEED_FILE = path.join');
  const j = src.indexOf('async function runEntryScan');
  vm.runInContext(src.slice(i, j) + ';this.feed = feedAppend; this.FILE = FEED_FILE;', ctx);
  ctx.logs = logs;
  return ctx;
}
const read = ctx => fs.readFileSync(ctx.FILE, 'utf8').trim().split('\n').map(JSON.parse);

console.log('\nЗапись прохода');
{
  const ctx = load('write');
  ctx.feed(1700000000000, [
    { coin: 'BTC', price: 77244.95, dayFallPct: 3.456, pullbackPct: 1.234,
      spreadPct: 0.0123, rsi: 41.7, chg24Pct: -2.345, inListMin: 12 },
    { coin: 'ETH', price: 0.00012345678, dayFallPct: 0, pullbackPct: 0, spreadPct: 0, rsi: 0, chg24Pct: 0, inListMin: 0 },
  ]);
  const [line] = read(ctx);
  ok(line.t === 1700000000000, 'время прохода записано');
  ok(line.r.length === 2, 'обе монеты записаны');
  ok(line.r[0][0] === 'BTC' && line.r[0][1] === 77244.95, 'монета и цена на месте');
  ok(line.r[0][2] === 3.46 && line.r[0][3] === 1.23, 'падение и откат округлены до сотых');
  ok(line.r[0][4] === 0.012, 'спред до тысячных: он меньше остальных на порядок');
  ok(line.r[0][7] === 12, 'давность в списке целым числом минут');
  ok(line.r[1][1] === 0.00012345678, 'копеечная цена не теряет знаков');
  ctx.feed(2, [{ coin: 'TINY', price: 0.0000000123456789 }]);
  ok(read(ctx)[1].r[0][1] === 1.2345679e-8, 'и совсем копеечная тоже — цена хранится значащими цифрами',
    String(read(ctx)[1].r[0][1]));
  ok(read(ctx)[0].r[1].every(v => v === 'ETH' || v === 0 || v === 0.00012345678),
    'настоящие нули записаны нулями, а не потеряны');
}

console.log('\nНеизвестное остаётся пустым');
{
  // Number(null) — это ноль, и он конечен. Через наивную проверку неизвестный
  // спред записался бы нулём, то есть идеальным, а неизвестное падение —
  // нулём, то есть «монета на пике». По такой ленте вывод будет обратным.
  const ctx = load('nulls');
  ctx.feed(1, [{ coin: 'X', price: null, dayFallPct: undefined, pullbackPct: '',
    spreadPct: false, rsi: NaN, chg24Pct: 'нет', inListMin: null }]);
  const [row] = read(ctx)[0].r;
  ok(row[0] === 'X', 'имя монеты остаётся');
  ok(row.slice(1).every(v => v === null), 'все неизвестные поля — пустые, ни одного нуля',
    JSON.stringify(row));
}

console.log('\nЛента не роняет скан и не съедает диск');
{
  const ctx = load('guard');
  // Сломанная запись не должна выбрасывать наружу: это наблюдение, а не торговля
  let threw = false;
  try { ctx.feed(1, null); } catch { threw = true; }
  ok(!threw, 'ошибка записи не выбрасывается в скан');
  ok(ctx.logs.some(m => /ОШИБКА/.test(m)), 'но она попадает в журнал сервера');
  ok(/FEED_MAX_BYTES = 200 \* 1024 \* 1024/.test(src), 'у файла есть потолок размера');
  ok(/FEED_KEEP_BYTES/.test(src) && /subarray/.test(src), 'при переполнении хвост сохраняется, а не всё стирается');
  ok(/entry-feed\.jsonl/.test(fs.readFileSync('.gitignore', 'utf8')), 'лента не лезет в репозиторий');
  ok(/feedAppend\(entryScan\.at, rows\)/.test(src), 'пишется каждый проход скана');
  // Пишется ПОСЛЕ того, как скан разложен: иначе в ленту попадёт полупустой проход
  ok(src.indexOf('feedAppend(entryScan.at, rows)') > src.indexOf('entryScan.results = rows'),
    'запись идёт после готового прохода');
}

console.log('\nПодрезка по размеру');
{
  const ctx = load('trim');
  // Потолок трогать не будем — проверяем, что счёт идёт по факту размера файла
  const cut = src.slice(src.indexOf('const size = fs.statSync(FEED_FILE).size;'),
    src.indexOf('} catch (e) {', src.indexOf('const size = fs.statSync(FEED_FILE).size;')));
  ok(/size > FEED_MAX_BYTES/.test(cut), 'подрезка только при превышении потолка');
  ok(/indexOf\(10/.test(cut), 'режется по границе строки, а не посередине записи');
  ctx.feed(1, [{ coin: 'A', price: 1 }]);
  ctx.feed(2, [{ coin: 'B', price: 2 }]);
  ok(read(ctx).length === 2, 'до потолка ничего не режется');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
