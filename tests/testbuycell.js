// Слово «брать» появляется само, когда клетка пройдёт порог.
//
// Правило записано заранее, до того как посмотрели на числа: клетке нужен
// плюс после издержек с запасом в две ошибки И на первой половине периода, И
// на второй. Сейчас таких клеток нет — список в ENTRY_NET пуст, и панель
// говорит «наблюдать». Дописывать для включения ничего не придётся: список
// приходит с сервера, и «брать» идёт вместе с планом выхода.
//
// План выхода обязателен. Цель +0.30% равна круговому обороту тейкером, и
// «брать» без срока и цели — это сделка, которую съедает комиссия.
const fs = require('fs'), vm = require('vm');
const view = require('../public/js/recovery-journal');
const { recoveryBuyCell, recoveryVerdict, recoveryObservation, recoveryOrder } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const now = Date.now();

const CELL = { lo: 10, deep: false, horizonH: 4, target: 2, netA: 0.31, seA: 0.1, netB: 0.28, seB: 0.09, n: 900 };
const scan = { recoveryMeasuredAt: '2026-09-09', at: now, serverNow: now,
  entryNet: { from: '2026-08-09', to: '2026-09-13', panel: -0.299, panelSe: 0.012,
    control: -0.285, controlSe: 0.008, n: 10588, controlN: 18523, modes: 16, plusModes: 0, buyCells: [CELL] },
  recheck: { current: true, code: 1, at: now, report: { version: 2, status: 'drift',
    referenceDate: '2026-09-09', from: now - 4 * 86400000, to: now - 300000, missingCoins: [],
    cells: [
      { lo: 0, deep: false, actual: 45.1, se: 3.91, coins: 23, n: 1911 },
      { lo: 3, deep: false, actual: 57.74, se: 2.38, coins: 36, n: 4951 },
      { lo: 10, deep: false, actual: 79.07, se: 1.88, coins: 13, n: 1123 },
    ] } } };
const gate = { fall: 3, spread: 0.3 };
const row = over => ({ coin: 'FIL', price: 1, dayFallPct: 12, pullbackPct: 0.9, chg24Pct: 1.5,
  spreadPct: 0.1, inListMin: 5, rsi: 20, ...over });
const verdict = (x, data = scan) =>
  recoveryVerdict(x, gate, recoveryObservation(x, data, now), recoveryBuyCell(x, data));

console.log('\nРазрешение ищется по клетке строки');
{
  ok(recoveryBuyCell(row(), scan) === CELL, 'падение больше 10% и мелкий откат — та самая клетка');
  ok(recoveryBuyCell(row({ dayFallPct: 4 }), scan) === null, 'другая глубина падения — не она');
  ok(recoveryBuyCell(row({ pullbackPct: 2 }), scan) === null, 'глубокий откат — отдельная клетка');
  ok(recoveryBuyCell(row(), { ...scan, entryNet: { buyCells: [] } }) === null, 'пустой список ничего не разрешает');
  ok(recoveryBuyCell(row(), {}) === null, 'нет измерения — нет разрешения');
  ok(recoveryBuyCell(row({ dayFallPct: null }), scan) === null, 'без падения клетка не определяется');
  // Испорченная запись не должна открывать покупку
  for (const broken of [{ ...CELL, horizonH: null }, { ...CELL, target: 0 }, { ...CELL, target: 'две' }]) {
    ok(recoveryBuyCell(row(), { ...scan, entryNet: { buyCells: [broken] } }) === null,
      'клетка без исправного плана выхода не разрешает покупку');
  }
}

console.log('\nВердикт и план выхода');
{
  const v = verdict(row());
  ok(v.label === 'брать 4ч +2%', 'в строке слово «брать» вместе с горизонтом и целью', v.label);
  ok(v.tier === 4, 'уровень выше всех остальных');
  ok(/цель \+2% лимитом, срок 4 ч/.test(v.why), 'план выхода назван в подсказке');
  ok(/0\.31% на поиске и 0\.28% на проверке/.test(v.why), 'и оба измерения, на которых он держится');
  ok(/средний результат группы/.test(v.why), 'без обещания по конкретной монете');
  ok(v.color === '#00ffa8' && /rgba\(0,255,168/.test(v.bg), 'строка выделена отдельно от прочих');
}

console.log('\nЧего разрешение не перебивает');
{
  ok(verdict(row({ chg24Pct: -14 })).label === 'риск', 'суточный размах сильнее разрешения');
  ok(verdict(row({ spreadPct: 0.9 })).tier === 0, 'широкий спред тоже');
  ok(verdict(row({ dayFallPct: 1 })).tier === 0, 'и непройденный порог падения');
  ok(verdict(row(), { ...scan, entryNet: { buyCells: [] } }).label === 'наблюдать',
    'пока разрешений нет — прежнее «наблюдать»');
  // Разрешение не требует свежей частоты: оно измерено отдельно и прямо
  ok(verdict(row(), { ...scan, recheck: null }).label === 'брать 4ч +2%',
    'клетка разрешена даже когда свежей частоты нет');
}

console.log('\nПорядок: разрешённые сверху');
{
  const ord = (x, data = scan) => recoveryOrder(x, data, verdict(x, data), recoveryObservation(x, data, now), now);
  ok(ord(row()) > ord(row({ dayFallPct: 4 })), 'строка «брать» выше измеренной «наблюдать»');
  ok(ord(row()) > 2000, 'и вообще выше всех');
  ok(ord(row({ chg24Pct: -14 })) === -1, 'риск остаётся внизу');
}

console.log('\nОбе вёрстки');
for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  const src = read(file);
  ok(src.includes('recoveryVerdict(x, gate, recoveryObservation(x, j), recoveryBuyCell(x, j))'),
    name + ': разрешение передаётся в вердикт');
  const start = src.indexOf('        const swingMark = (x) => {');
  const end = src.indexOf('        box.innerHTML = head + renderRecoveryStatus', start);
  const ctx = { ...view, j: scan, gate, good: [row()], price: x => String(x) };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + ';this.cell = cell;', ctx);
  const html = ctx.cell(row());
  ok(html.includes('брать 4ч +2%'), name + ': слово и план выхода видны в строке');
  ok(html.includes('rgba(0,255,168'), name + ': строка выделена заливкой');
  const off = { ...scan, entryNet: { ...scan.entryNet, buyCells: [] } };
  const ctx2 = { ...view, j: off, gate, good: [row()], price: x => String(x) };
  vm.createContext(ctx2);
  vm.runInContext(src.slice(start, end) + ';this.cell = cell;', ctx2);
  ok(!ctx2.cell(row()).includes('брать 4ч'), name + ': без разрешения слова нет');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
