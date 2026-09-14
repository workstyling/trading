// Комиссии бумажных сделок — по способу исполнения, а не одной ставкой.
//
// Лаборатории считали обе стороны по ставке мейкера (0.075%). Но покупка идёт
// сразу по лучшему ask — это забирает встречную заявку, то есть тейкер
// (0.15%). Мейкер платят только там, где заявка стояла в стакане: выход по
// цели. Стоп и выход по времени исполняются по наблюдаемому биду — тейкер.
//
// Занижение комиссии красит стратегию лучше, чем она есть: внешняя проверка
// насчитала около −$54 разницы на 44 закрытых записях.
//
// Записи прежней модели пересчитывать задним числом нельзя: прошлые выводы
// должны остаться воспроизводимыми. Поэтому на сделке сохраняются ставки и
// версия модели (fm), а старые записи считаются по-старому.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = read('server.js');

const MAKER = 0.00075, TAKER = 0.0015;

console.log('\nСервер: paperPnl');
{
  const ctx = {
    Math, Number, console,
    loadSettings: () => ({ tradeFee: 0.075, marketFee: 0.15 }),
    defaultSettings: { tradeFee: 0.125, marketFee: 0.25 },
  };
  vm.createContext(ctx);
  for (const name of ['function paperLimitFee', 'function paperTakerFee', 'function paperFees', 'function paperPnl']) {
    const i = src.indexOf(name);
    ok(i > 0, name.replace('function ', '') + ' на месте');
    vm.runInContext(src.slice(i, src.indexOf('\n}', i) + 2), ctx);
  }
  vm.runInContext('this.pnl = paperPnl; this.fees = paperFees;', ctx);

  ok(Math.abs(ctx.fees({ fm: 2 }).entry - TAKER) < 1e-9, 'вход новой модели — тейкер',
    String(ctx.fees({ fm: 2 }).entry));
  ok(Math.abs(ctx.fees({ fm: 2 }).maker - MAKER) < 1e-9, 'мейкер берётся из своей настройки');
  // Запись без версии — прежняя модель: одна ставка с обеих сторон
  ok(ctx.fees({ feePct: MAKER }).legacy === true, 'запись без версии считается прежней моделью');
  ok(ctx.fees({ feePct: MAKER }).taker === MAKER, 'и обе стороны у неё по её же ставке');

  // Одна и та же сделка, закрытая по цели и по стопу, платит разную комиссию
  const pos = { entry: 100, budget: 1000, feeEntryPct: TAKER, feeMakerPct: MAKER, feeTakerPct: TAKER, fm: 2 };
  pos.qty = pos.budget * (1 - TAKER) / pos.entry;
  const tp = ctx.pnl(pos, 102, 'tp');
  const sl = ctx.pnl(pos, 102, 'taker');
  ok(tp > sl, 'выход по цели дешевле выхода по стопу', 'tp ' + tp + ' против ' + sl);
  // Ровно на разницу ставок: 1000·(1−taker)/100 · 102 · (taker − maker)
  const expect = Math.round(pos.qty * 102 * (TAKER - MAKER) * 100) / 100;
  ok(Math.abs((tp - sl) - expect) < 0.02, 'и разница равна разнице ставок',
    (tp - sl).toFixed(2) + ' против ожидаемых ' + expect.toFixed(2));

  // Прежняя модель считала обе стороны мейкером и завышала итог
  const oldWay = Math.round((pos.budget * (1 - MAKER) / 100 * 102 * (1 - MAKER) - pos.budget) * 100) / 100;
  ok(oldWay > tp, 'прежняя модель показывала больше, чем есть',
    'было ' + oldWay + ', стало ' + tp);

  // Старая запись без версии модели считается по-старому
  const old = { entry: 100, budget: 1000, feePct: MAKER, qty: 1000 * (1 - MAKER) / 100 };
  ok(Math.abs(ctx.pnl(old, 102, 'taker') - oldWay) < 0.02,
    'запись прежней модели не переписывается задним числом', String(ctx.pnl(old, 102, 'taker')));
}

console.log('\nСервер: способ выхода записывается на сделке');
{
  const close = src.slice(src.indexOf('function closePaperPos'), src.indexOf('function closePaperPos') + 900);
  ok(/pos\.exitKind = reason === 'TP' \? 'tp' : 'taker'/.test(close), 'по цели — мейкер, остальное — тейкер');
  ok(/paperPnl\(pos, price, pos\.exitKind\)/.test(close), 'и итог считается по нему');

  const build = src.slice(src.indexOf('function buildPaperPos'), src.indexOf('function buildPaperPos') + 1400);
  ok(/feeEntryPct: taker/.test(build), 'вход в позицию — по ставке тейкера');
  ok(/fm: 2/.test(build), 'и версия модели записана на сделке');
  ok(/qty: budget \* \(1 - fee\) \/ ask/.test(build) && /const fee = taker;/.test(build),
    'объём покупки посчитан тем же тейкером');
}

console.log('\nЛаборатория микро-скальпа');
{
  const lab = read('src/micro-scalp/lab.js');
  ok(/feeMakerPct/.test(lab) && /feeTakerPct/.test(lab), 'обе ставки доходят до сделки');
  ok(/trade\.exitKind = why === 'TP' \? 'tp' : 'taker'/.test(lab), 'способ выхода определяется причиной закрытия');
  ok(/trade\.fm !== 2 \? execution\.feePct/.test(lab), 'старые записи считаются прежней ставкой');
  ok(/fm: 2,/.test(lab), 'новые помечены версией модели');
  ok(/qty: state\.budget \* \(1 - \(execution\.feeTakerPct != null \? execution\.feeTakerPct : execution\.feePct\)\)/.test(lab),
    'объём покупки — по тейкеру');

  // Отпечаток модели исполнения обязан меняться вместе с ней, иначе старая и
  // новая статистика молча смешаются в одной когорте
  ok(/executionModel: 'ask-entry \/ limit-target \/ observed-bid-stop-time-v1'/.test(src) === false ||
     /feeMakerPct/.test(src), 'ставки входят в описание исполнения');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
