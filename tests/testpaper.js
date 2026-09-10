// Форвардный журнал: открывает по одной сделке на монету, не считает повторы
// за новые сделки и сравнивает обещанное панелью с случившимся.
const fs = require('fs'), vm = require('vm'), os = require('os'), path = require('path');
const src = fs.readFileSync('server.js', 'utf8');
const start = src.indexOf('const ENTRY_PAPER_FILE = path.join(__dirname');
const end = src.indexOf("app.get('/api/entry-scan'", start);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-'));
const routes = {};
let candles = [];

function load() {
  const ctx = {
    fs, path, JSON, Date, Math, Set, Array, Number, console,
    __dirname: dir, setInterval: () => 0,
    // Короткие паузы внутри расчёта пропускаем, длинные (планировщик) глушим:
    // заглушка `() => 0` оставляла await висеть навсегда и тест молча обрывался.
    setTimeout: (fn, ms) => { if (ms <= 1000) Promise.resolve().then(fn); return 0; },
    DIP_CB: 'https://x', DIP_H: {},
    // Порог спреда объявлен ВЫШЕ вырезанного куска, а внутри куска стоит
    // сверка: он обязан совпадать с целью. Берём настоящее число из кода —
    // подставь сюда своё, и сверка перестанет что-либо значить.
    ENTRY_GATE_SPREAD: Number((src.match(/const ENTRY_GATE_SPREAD = ([\d.]+)/) || [])[1]),
    ENTRY_GATE_FALL: Number((src.match(/const ENTRY_GATE_FALL = ([\d.]+)/) || [])[1]),
    // Метка правила: со сменой правила журнал начинает отсчёт заново, иначе
    // сделки старого и нового правила сложились бы в одну кучу.
    ENTRY_RULE: (src.match(/const ENTRY_RULE = '([^']+)'/) || [])[1],
    fetch: async () => ({ ok: true, json: async () => candles }),
    app: { get: (p, h) => { routes[p] = h; } },
  };
  vm.createContext(ctx);
  // Настоящая сетка возврата, а не её копия в тесте: копия успела отстать на
  // целое измерение — она была одномерной, когда код стал двумерным.
  vm.runInContext(src.match(/function recoveryOdds[\s\S]*?\n}/)[0], ctx);
  // И настоящий вход: журнал обязан открывать ровно то, что панель зовёт
  // покупать. Своя копия условия здесь означала бы, что проверяется тест.
  vm.runInContext(src.match(/function entryPasses[\s\S]*?\n}/)[0], ctx);
  vm.runInContext(src.slice(start, end) +
    ';this.entryPaper = entryPaper; this.entryPaperOpen = entryPaperOpen; this.entryPaperSettle = entryPaperSettle; this.saveEntryPaper = saveEntryPaper;', ctx);
  return ctx;
}

let bad = 0;
const ok = (c, n, d) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'FAIL') + '  ' + n + (d ? '   ' + d : '')); };
const row = (coin, pct, over = {}) => ({
  // Вход теперь решают падение и спред, а не балл: балл измерен ровным
  // от 1 до 100 и из условия убран. Здесь он остаётся только записью.
  coin, pair: coin + '-USD', price: 100, dayFallPct: 5, spreadPct: 0.2,
  recovery: { hour: 75, stuck: 1.4 }, inListMin: 0,
  entryValue: { pct }, ...over,
});

process.on('unhandledRejection', e => { console.error('УПАЛО:', e); process.exit(1); });

(async () => {
  let ctx = load();
  // Обещание берём из действующей таблицы, а не числом в тесте: таблица
  // перемеряется, и вбитое число тихо разошлось бы с кодом.
  const REC7 = ctx.recoveryOdds(7).hour;

  // открываются только те, кто прошёл порог
  ctx.entryPaperOpen([row('AAA', 80), row('BBB', 39), row('CCC', 45, { spreadPct: 0.9 })]);
  const main = ctx.entryPaper.trades.filter(t => !t.control);
  const ctrl = ctx.entryPaper.trades.filter(t => t.control);
  ok(main.length === 2 && !main.some(t => t.coin === 'CCC'), 'основными взяты только прошедшие вход',
    main.map(t => t.coin + ':' + t.score).join(' '));
  ok(ctrl.length === 1 && ctrl[0].coin === 'CCC', 'а широкий спред ушёл в контроль',
    ctrl.length ? ctrl[0].coin + ':' + ctrl[0].score : 'нет');
  ok(ctx.entryPaper.trades.every(t => t.entry === 100 && t.pair), 'записаны цена входа и пара');

  // повторный сигнал по той же монете новой сделкой не считается
  ctx.entryPaperOpen([row('AAA', 90)]);
  ok(ctx.entryPaper.trades.filter(t => t.coin === 'AAA').length === 1,
    'повтор по открытой монете не удваивает сделку');

  // монета, давно висящая в списке, тоже не считается новой
  ctx.entryPaper.trades = [];
  ctx.entryPaperOpen([row('DDD', 90, { inListMin: 300 })]);
  ok(ctx.entryPaper.trades.filter(t => !t.control).length === 0,
    'вход в середине затянувшейся серии не открывает сделку');

  // расчёт по свечам
  ctx.entryPaper.trades = [{
    id: 'x', coin: 'AAA', pair: 'AAA-USD', at: Date.now() - 70 * 60000,
    entry: 100, score: 80, dayFall: 7, recHour: 75, rule: ctx.ENTRY_RULE,
  }];
  const t0 = ctx.entryPaper.trades[0].at;
  // [время, low, high, open, close, объём] — как отдаёт Coinbase
  candles = [];
  for (let m = 0; m <= 65; m += 5) {
    const px = 100 + (m === 20 ? 0.5 : m * 0.005);       // на 20-й минуте задело +0.5%
    candles.push([Math.floor((t0 + m * 60000) / 1000), px - 0.4, px, px, px, 1]);
  }
  await ctx.entryPaperSettle();
  const t = ctx.entryPaper.trades[0];
  ok(t.done60 === true, 'сделка посчитана через час');
  ok(t.hit60 === 20, 'зафиксировано, за сколько минут дошло до +0.30%', String(t.hit60));
  ok(t.m5 != null && t.m15 != null && t.m60 != null, 'отметки 5/15/60 минут заполнены',
    [t.m5, t.m15, t.m60].join(' / '));
  ok(t.mae60 <= 0, 'просадка по пути записана', String(t.mae60));
  // обещание пересчитано по действующей таблице, старое сохранено рядом
  ok(t.recHour === REC7 && t.recHourAtOpen === 75,
    'обещание приведено к действующей таблице, прежнее сохранено',
    t.recHour + ' (было ' + t.recHourAtOpen + ')');

  // попадание позже часа не должно считаться часовым: свечи качаются до 65-й
  // минуты, и цель, задетая на 63-й, засчитывалась как «дошло за час»
  ctx.entryPaper.trades = [{
    id: 'y', coin: 'BBB', pair: 'BBB-USD', at: Date.now() - 70 * 60000,
    entry: 100, score: 80, dayFall: 7, recHour: 75, rule: ctx.ENTRY_RULE,
  }];
  const t1 = ctx.entryPaper.trades[0].at;
  candles = [];
  for (let m = 0; m <= 65; m += 5) {
    const px = m >= 63 ? 101 : 99.9;                 // цель задета только на 65-й
    candles.push([Math.floor((t1 + m * 60000) / 1000), px - 0.1, px, px, px, 1]);
  }
  await ctx.entryPaperSettle();
  ok(ctx.entryPaper.trades[0].hit60 === null,
    'цель, задетая после 60-й минуты, часовой не считается',
    String(ctx.entryPaper.trades[0].hit60));

  // контрольная запись не должна блокировать основную по той же монете
  ctx.entryPaper.trades = [];
  ctx.entryPaperOpen([row('EEE', 10), row('ZZZ', 12, { spreadPct: 0.9 })]);   // вторая уйдёт в контроль
  const ctrlCoin = ctx.entryPaper.trades.find(t => t.control).coin;
  ctx.entryPaperOpen([row(ctrlCoin, 95)]);                   // спред сузился — монета прошла вход
  ok(ctx.entryPaper.trades.some(t => t.coin === ctrlCoin && !t.control),
    'монета из контроля записывается основной, когда проходит порог', ctrlCoin);

  // расчёт по свечам (возврат к исходной сделке)
  ctx.entryPaper.trades = [{
    id: 'x', coin: 'AAA', pair: 'AAA-USD', at: Date.now() - 70 * 60000,
    entry: 100, score: 80, dayFall: 7, recHour: 75, rule: ctx.ENTRY_RULE,
  }];
  const t2 = ctx.entryPaper.trades[0].at;
  candles = [];
  for (let m = 0; m <= 65; m += 5) {
    const px = 100 + (m === 20 ? 0.5 : m * 0.005);
    candles.push([Math.floor((t2 + m * 60000) / 1000), px - 0.4, px, px, px, 1]);
  }
  await ctx.entryPaperSettle();

  // отчёт сравнивает обещанное с фактическим
  let out = null;
  await routes['/api/entry-paper']({}, { json: x => { out = x; } });
  ok(out.overall && out.overall.n === 1, 'посчитанная сделка попала в отчёт');
  ok('control' in out, 'контрольная группа есть в отчёте отдельной строкой');
  ok(out.trades[0].control === false, 'в строке видно, основная сделка или контрольная');
  const pf = out.promiseVsFact.find(x => x.label === '>10%' || x.label === '6-10%');
  ok(out.promiseVsFact.some(x => x.promised === REC7), 'обещание панели сохранено рядом с фактом',
    JSON.stringify(out.promiseVsFact.filter(x => x.n)));
  ok(out.needPct === 0.3, 'порог окупаемости назван');
  ok(Array.isArray(out.trades) && out.trades.length === 1, 'сами сделки перечислены — иначе журнал нечем проверить');
  ok(out.trades[0].coin === 'AAA' && out.trades[0].promised === REC7 && out.trades[0].state === 'посчитана',
    'в строке видно монету, обещание и состояние', JSON.stringify(out.trades[0]));

  // сделки, посчитанные старым кодом, при перезапуске сбрасываются на пересчёт
  ctx.entryPaper.trades = [
    { id: 'old', coin: 'OLD', pair: 'OLD-USD', at: Date.now() - 9e6, entry: 1, score: 80, dayFall: 7, done60: true, hit60: 61 },
    { id: 'new', coin: 'NEW', pair: 'NEW-USD', at: Date.now() - 9e6, entry: 1, score: 80, dayFall: 7, done60: true, v2: true, hit60: 20 },
  ];
  ctx.saveEntryPaper ? ctx.saveEntryPaper() : null;
  {
    const reload = load();
    const oldT = reload.entryPaper.trades.find(t => t.coin === 'OLD');
    const newT = reload.entryPaper.trades.find(t => t.coin === 'NEW');
    ok(oldT && !oldT.done60, 'сделка старого расчёта сброшена на пересчёт');
    ok(newT && newT.done60 === true, 'сделка нового расчёта не тронута');
  }

  // журнал переживает перезапуск
  const before = ctx.entryPaper.trades.length;
  ctx = load();
  ok(ctx.entryPaper.trades.length === before, 'журнал прочитан с диска после перезапуска');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе проверки прошли');
})().catch(e => { console.error('УПАЛО:', e); process.exit(1); });
