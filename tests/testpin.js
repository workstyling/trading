'use strict';
// Закрепление монеты (📌) и строгая лексикографичность весов порядка.
const fs = require('fs');
const view = require('../public/js/recovery-journal');
const { recoveryTogglePin, recoveryPinSet, recoveryPinButton, renderRecoveryGroups, recoveryOrder } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const now = Date.now();

console.log('Закрепление: переключается и чистит имя');
{
  for (const coin of [...recoveryPinSet()]) recoveryTogglePin(coin); // чистый старт
  ok(recoveryTogglePin('ETH').has('ETH'), 'первый клик закрепляет');
  ok(!recoveryTogglePin('ETH').has('ETH'), 'второй — открепляет');
  const cleaned = recoveryTogglePin('<b>eth</b>');
  ok(cleaned.has('bethb') && cleaned.size === 1, 'имя чистится до букв и цифр', [...cleaned].join(','));
  recoveryTogglePin('bethb');
  ok(recoveryTogglePin('').size === 0, 'пустое имя ничего не меняет');
}

console.log('Кнопка не меняет разрешений и останавливает клик строки');
{
  const off = recoveryPinButton('SOL', 'reload()');
  ok(off.includes('event.stopPropagation()'), 'клик по кнопке не проваливается в строку');
  ok(off.includes("recoveryTogglePin('SOL')") && off.includes('reload()'), 'кнопка переключает и перерисовывает');
  ok(off.includes('не меняются'), 'подсказка говорит, что статус и разрешение не меняются');
  recoveryTogglePin('SOL');
  ok(recoveryPinButton('SOL', 'r()').includes('Открепить SOL'), 'закреплённая кнопка предлагает открепить');
  recoveryTogglePin('SOL');
}

console.log('Секция закреплённых — в самом верху, строки не дублируются');
{
  // Скан без свежей проверки: все строки уходят в «Остальные».
  const scan = { at: now, serverNow: now, recoveryMeasuredAt: '2026-09-09',
    gate: { fallPct: 3, spreadPct: 0.3 }, entryNet: { buyCells: [] } };
  const rows = [{ coin: 'FIL', price: 1, dayFallPct: 4, pullbackPct: 0.9, spreadPct: 0.1 },
    { coin: 'AAVE', price: 1, dayFallPct: 4, pullbackPct: 0.9, spreadPct: 0.1 }];
  const render = r => '<tr data-coin="' + r.coin + '"><td>' + r.coin + '</td></tr>';
  const withPin = renderRecoveryGroups(rows, scan, render, 7, new Set(['AAVE']));
  ok(withPin.indexOf('Закреплённые вручную · 1') >= 0, 'секция названа и посчитана');
  ok(withPin.indexOf('Закреплённые') < withPin.indexOf('Покупать'), 'закреплённые выше «Покупать»');
  ok(withPin.indexOf('data-entry-group="pinned"') >= 0, 'секция помечена для вёрстки');
  ok(withPin.split('data-coin="AAVE"').length === 2, 'закреплённая строка не дублируется в своей группе');
  ok(withPin.split('data-coin="FIL"').length === 2 &&
    withPin.indexOf('data-coin="AAVE"') < withPin.indexOf('data-coin="FIL"'), 'незакреплённая осталась на месте, ниже');
  const noPin = renderRecoveryGroups(rows, scan, render, 7);
  ok(!noPin.includes('Закреплённые'), 'без закреплённых секции нет');
  ok(!noPin.includes('pinned'), 'и пустая секция не рисуется');
}

console.log('Веса порядка строго лексикографичны');
{
  const scan = { at: now, serverNow: now, entryNet: { buyCells: [] },
    pullbackNet: { at: now, steep: { at: 3, verdict: 'хуже', hour: { band: -0.5, bandSe: 0.09, base: -0.28, baseSe: 0.01, diff: -0.26, se: 0.09 } } } };
  const v = { tier: 1, label: 'наблюдать' };
  const order = (row, hour) => recoveryOrder(row, scan, v, { hour }, now);
  const base = { coin: 'A', price: 1, inListMin: 5, pullbackPct: 0.5 };
  // Перегруженная портфелем монета с известным спредом и частотой 100% всё
  // равно ниже свободной с неизвестным спредом: прежние веса это нарушали.
  ok(order({ ...base, bookPct: 25, spreadPct: 0.01 }, 100) < order({ ...base, coin: 'B', spreadPct: null }, 1),
    'ключ портфеля не перевешивается спредом и частотой');
  // Резкий провал от измеренного порога — измеренно хуже: ниже при прочих равных.
  ok(order({ ...base, pullbackPct: 3.5 }, 80) < order({ ...base, coin: 'C', pullbackPct: 0.5 }, 60),
    'измеренно-худший резкий провал ниже даже с большей частотой');
  ok(order({ ...base, pullbackPct: 3.5, spreadPct: 0.1 }, 80) >
     order({ ...base, coin: 'D', pullbackPct: 3.5, spreadPct: 0.1 }, 60),
    'между двумя резкими — по частоте');
  // Замера нет — ключ нейтрален: отсутствие данных не наказание и не награда.
  const noMeasure = { at: now, serverNow: now, entryNet: { buyCells: [] } };
  const o2 = (row, hour) => recoveryOrder(row, noMeasure, v, { hour }, now);
  ok(o2({ ...base, pullbackPct: 3.5 }, 60) === o2({ ...base, coin: 'E', pullbackPct: 0.5 }, 60),
    'без замера резкий провал порядок не меняет');
}

console.log('Кнопка и закреплённые есть в обеих вёрстках');
for (const [file, reload] of [['public/index.html', 'loadEntryScan()'], ['public/mobile/index.html', 'loadEntryScanM()']]) {
  const src = fs.readFileSync(file, 'utf8');
  ok(src.includes("recoveryPinButton(safe, '" + reload + "'"), file + ': кнопка перерисовывает свою вёрстку');
  ok(new RegExp('renderRecoveryGroups\\(ranked, j, cell, [47], recoveryPinSet\\(\\)\\)').test(src),
    file + ': закреплённые переданы в группы');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
