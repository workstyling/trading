// Форвардный журнал: правильно ли он считает то, ради чего заведён.
//
// Он отвечает на один вопрос — стоит ли правило входа чего-нибудь против
// случайного выбора. Две вещи делали ответ неверным:
//
// 1. Ошибка считалась по сделкам, будто они независимы. Один проход сканера
//    открывает сразу пачку — все монеты, прошедшие вход в эту минуту, — и
//    целый час они плывут по одному и тому же рынку. Полторы сотни сделок
//    могут оказаться двумя десятками рыночных моментов, и выборка завышена в
//    разы.
//
// 2. Контроль отбирался не теми же условиями. Основная группа берёт только
//    первое пересечение серии (inListMin <= 4), а в контроль попадала любая
//    монета, включая висящую в списке часами. Разница в исходе выходила
//    разницей условий, а не правила.
const fs = require('fs'), vm = require('vm'), os = require('os'), path = require('path');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = read('server.js');

const start = src.indexOf('const ENTRY_PAPER_FILE = path.join(__dirname');
const end = src.indexOf("app.get('/api/entry-scan'", start);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
const routes = {};

function load() {
  const ctx = {
    fs, path, JSON, Date, Math, Set, Map, Array, Number, console,
    __dirname: dir, setInterval: () => 0, setTimeout: () => 0,
    DIP_CB: 'https://x', DIP_H: {},
    ENTRY_GATE_SPREAD: Number((src.match(/const ENTRY_GATE_SPREAD = ([\d.]+)/) || [])[1]),
    ENTRY_GATE_FALL: Number((src.match(/const ENTRY_GATE_FALL = ([\d.]+)/) || [])[1]),
    ENTRY_RULE: (src.match(/const ENTRY_RULE = '([^']+)'/) || [])[1],
    fetch: async () => ({ ok: true, json: async () => [] }),
    app: { get: (p, h) => { routes[p] = h; } },
  };
  vm.createContext(ctx);
  vm.runInContext(src.match(/function recoveryOdds[\s\S]*?\n}/)[0], ctx);
  vm.runInContext(src.match(/function entryPasses[\s\S]*?\n}/)[0], ctx);
  vm.runInContext(src.slice(start, end) +
    ';this.entryPaper = entryPaper; this.entryPaperOpen = entryPaperOpen;', ctx);
  return ctx;
}

const report = async (ctx) => {
  let out = null;
  await routes['/api/entry-paper']({}, { json: (x) => { out = x; } });
  return out;
};
// Посчитанная сделка: скан (момент открытия), результат через час, дошло ли
const t = (at, m60, hit, control) => ({
  id: 'x' + Math.random(), coin: 'C' + Math.random().toString(36).slice(2, 6), pair: 'X-USD',
  at, entry: 100, score: 50, dayFall: 4, rule: null,
  done60: true, m5: 0, m15: 0, m60, hit60: hit ? 10 : null, mae60: -0.5,
  control: control || undefined, cv: control ? 2 : undefined,
});

(async () => {
  const ctx = load();
  const RULE = ctx.ENTRY_RULE;
  const mark = (x) => { x.rule = RULE; return x; };

  console.log('\nОшибка считается по сканам, а не по сделкам');
  {
    // Три скана по десять сделок. Внутри скана исход одинаковый — рынок один.
    // По сделкам это тридцать наблюдений, на деле три.
    const trades = [];
    [[1000, 1], [2000, -1], [3000, 0]].forEach(([at, v]) => {
      for (let i = 0; i < 10; i++) trades.push(mark(t(at, v, v > 0, false)));
    });
    // Контролю нужно не меньше десяти, иначе сравнение не строится
    for (let i = 0; i < 12; i++) trades.push(mark(t(5000 + i, 0, false, true)));
    ctx.entryPaper.trades = trades;
    const r = await report(ctx);
    const o = r.overall;
    ok(o.n === 30, 'сделок тридцать', String(o.n));
    ok(o.scans === 3, 'а рыночных моментов три', String(o.scans));
    // sd по сделкам ≈ 0.82 → ошибка ≈ 0.15; по сканам sd = 1 → ошибка ≈ 0.577
    ok(o.m60se < 0.2, 'наивная ошибка мала — она и вводила в заблуждение', String(o.m60se));
    ok(o.m60seScan > 0.5, 'честная ошибка втрое больше', String(o.m60seScan));
    ok(o.m60seScan > o.m60se * 2, 'разница между ними и есть мера слипания сделок');

    // У контроля скан даёт одну сделку — обе оценки обязаны совпасть
    const c = r.control;
    ok(c.scans === c.n, 'у контроля сканов столько же, сколько сделок', c.scans + '/' + c.n);
    ok(Math.abs(c.m60seScan - c.m60se) < 0.001, 'и обе ошибки совпадают');
  }

  console.log('\nДоля дошедших до цели тоже с ошибкой');
  {
    const trades = [];
    // Два скана: в одном дошли все, в другом никто. Доля 50%, но уверенности в
    // ней никакой — по сделкам она выглядела бы точной.
    for (let i = 0; i < 10; i++) trades.push(mark(t(1000, 0.5, true, false)));
    for (let i = 0; i < 10; i++) trades.push(mark(t(2000, -0.5, false, false)));
    for (let i = 0; i < 12; i++) trades.push(mark(t(5000 + i, 0, false, true)));
    ctx.entryPaper.trades = trades;
    const r = await report(ctx);
    ok(r.overall.hitHour === 50, 'доля посчитана', String(r.overall.hitHour));
    ok(r.overall.hitHourSeScan >= 35, 'и ошибка у неё огромная, как и должно быть',
      '±' + r.overall.hitHourSeScan);
  }

  console.log('\nКонтроль отбирается теми же условиями');
  {
    const open = src.slice(src.indexOf('function entryPaperOpen'), src.indexOf('async function entryPaperSettle'));
    // Свежесть: только первое пересечение серии. У основной группы это было,
    // у контроля нет — и в него шли монеты, висящие в списке часами.
    ok((open.match(/inListMin != null && r?\.?o?w?\.?inListMin > 4/g) || []).length >= 1,
      'условие свежести есть у основной группы');
    const below = open.slice(open.indexOf('const below = rows.filter'));
    ok(/inListMin != null && r\.inListMin > 4/.test(below), 'и такое же — у контроля');
    ok(/cv: control \? 2 : undefined/.test(open), 'новые контрольные помечены версией отбора');

    // Проверяем поведением: висящая монета мимо входа в контроль не идёт
    const row = (coin, over) => ({
      coin, pair: coin + '-USD', price: 100, dayFallPct: 5, spreadPct: 0.2,
      recovery: { hour: 75 }, inListMin: 0, entryValue: { pct: 50 }, ...over,
    });
    ctx.entryPaper.trades = [];
    // Все мимо входа: одна свежая, одна висящая
    ctx.entryPaperOpen([
      row('OLD', { spreadPct: 0.9, inListMin: 300 }),
      row('NEW', { spreadPct: 0.9, inListMin: 1 }),
    ]);
    const ctrl = ctx.entryPaper.trades.filter(x => x.control);
    ok(ctrl.length === 1, 'в контроль ушла ровно одна', String(ctrl.length));
    ok(ctrl[0].coin === 'NEW', 'и это свежая, а не висящая часами', ctrl[0].coin);
    ok(ctrl[0].cv === 2, 'помечена версией отбора');

    ctx.entryPaper.trades = [];
    ctx.entryPaperOpen([row('OLD', { spreadPct: 0.9, inListMin: 300 })]);
    ok(ctx.entryPaper.trades.length === 0, 'если свежих мимо входа нет — контроль не берётся');
  }

  console.log('\nСтарый и новый контроль не смешиваются молча');
  {
    const trades = [];
    for (let i = 0; i < 12; i++) trades.push(mark(t(1000 + i, 0, false, false)));
    // Двадцать старых (без пометки) и пять новых: сопоставимых мало
    for (let i = 0; i < 20; i++) { const x = mark(t(3000 + i, -1, false, true)); delete x.cv; trades.push(x); }
    for (let i = 0; i < 5; i++) trades.push(mark(t(4000 + i, 1, true, true)));
    ctx.entryPaper.trades = trades;
    let r = await report(ctx);
    ok(r.control.n === 25, 'пока сопоставимых мало — берётся весь контроль', String(r.control.n));
    ok(/включая отобранный прежним способом/.test(r.controlBasis), 'и об этом сказано прямо', r.controlBasis);
    ok(r.controlFreshN === 5, 'видно, сколько сопоставимого уже набрано', String(r.controlFreshN));

    // Набралось достаточно — переходим на сопоставимый
    for (let i = 0; i < 30; i++) trades.push(mark(t(6000 + i, 1, true, true)));
    ctx.entryPaper.trades = trades;
    r = await report(ctx);
    ok(r.control.n === 35, 'когда набралось — берётся только сопоставимый', String(r.control.n));
    ok(r.controlBasis === 'сопоставимый', 'и это сказано', r.controlBasis);
  }

  console.log('\nОбе вёрстки берут честную ошибку');
  for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
    const h = read(file);
    ok(/g\.m60seScan != null \? g\.m60seScan/.test(h), name + ': ошибка разности — по сканам');
    ok(/hitHourSeScan/.test(h), name + ': у доли дошедших тоже есть ошибка');
    ok(/в пределах погрешности/.test(h), name + ': и незначимое названо незначимым');
    ok(/рыночных моментов/.test(h), name + ': в подсказке видно, сколько было моментов');
    ok(/controlBasis/.test(h), name + ': и на чём построен контроль');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('УПАЛО:', e); process.exit(1); });
