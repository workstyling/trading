'use strict';
// Вход вдогонку: рост за 15 минут перед входом измеренно хуже — строка не
// кандидат и опускается. Порог и числа приходят из замера на сервере.
const fs = require('fs');
const view = require('../public/js/recovery-journal');
const { chaseEntry, recoveryRowMark, recoveryOrder } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const now = Date.now();

const chaseNet = { at: '2026-11-23', threshold: 0, verdict: 'хуже',
  hour: { h1: { diff: -0.241, se: 0.026 }, h2: { diff: -0.281, se: 0.023 } },
  hit: { h1: { diff: -10.6, se: 0.8 }, h2: { diff: -13.1, se: 0.7 } } };
const scan = { at: now, serverNow: now, chaseNet, entryNet: { buyCells: [] } };

console.log('Пометка берёт порог и числа из замера');
{
  const row = { coin: 'A', price: 1, mom15Pct: 0.42 };
  const mark = chaseEntry(row, scan);
  ok(!!mark, 'рост за 15 минут выше порога помечается');
  ok(mark.why.includes('+0.42%'), 'в подсказке — ход самой монеты');
  ok(mark.why.includes('-0.241 ±0.026') && mark.why.includes('-0.281 ±0.023'), 'обе половины замера названы');
  ok(mark.why.includes('вырастет — куплю — упадёт'), 'причина объяснена словами владельца');
  ok(chaseEntry({ ...row, mom15Pct: 0 }, scan) === null, 'ход на пороге не помечается: порог строгий');
  ok(chaseEntry({ ...row, mom15Pct: -0.2 }, scan) === null, 'падение за 15 минут — не вдогонку');
  ok(chaseEntry({ ...row, mom15Pct: null }, scan) === null, 'нет хода — нет пометки');
  ok(chaseEntry(row, { ...scan, chaseNet: null }) === null, 'нет замера — нет пометки');
  ok(chaseEntry(row, { ...scan, chaseNet: { ...chaseNet, verdict: 'ноль' } }) === null, 'неподтверждённый замер не метит');
  ok(chaseEntry(row, { ...scan, chaseNet: { ...chaseNet, threshold: null } }) === null, 'замер без порога не используется');
}

console.log('Вдогонку — не кандидат');
{
  const verdict = { tier: 2, label: 'наблюдать', color: 'c', bg: 'b' };
  const row = { coin: 'A', price: 1, mom15Pct: 0.5 };
  const mark = recoveryRowMark(row, scan, verdict, { hour: 60 }, now);
  ok(mark.state === 'none' && mark.label === 'вдогонку', 'строка уходит из кандидатов с пометкой', mark.label);
  ok(mark.why.includes('вдогонку') || mark.why.includes('Вход вдогонку'), 'причина в подсказке');
  const calm = recoveryRowMark({ ...row, mom15Pct: -0.1 }, scan, verdict, { hour: 60 }, now);
  ok(calm.label !== 'вдогонку', 'спокойный вход пометки не получает');
  const confirmed = recoveryRowMark(row, scan, { ...verdict, tier: 4 }, { hour: 60 }, now);
  ok(confirmed.state === 'confirmed', 'подтверждённое разрешение пометка не трогает: оно измерено отдельно');
}

console.log('Порядок: вдогонку ниже спокойных, замер старше спреда и частоты');
{
  const v = { tier: 1, label: 'наблюдать' };
  const order = (row, hour, data = scan) => recoveryOrder(row, data, v, { hour }, now);
  const base = { coin: 'A', price: 1, inListMin: 5, spreadPct: 0.1, pullbackPct: 0.5 };
  ok(order({ ...base, mom15Pct: 0.6 }, 90) < order({ ...base, coin: 'B', mom15Pct: -0.1 }, 60),
    'вдогонку ниже спокойной даже с большей частотой');
  ok(order({ ...base, mom15Pct: 0.6 }, 90) > order({ ...base, coin: 'C', mom15Pct: 0.6 }, 60),
    'между двумя вдогонку — по частоте');
  const noMeasure = { at: now, serverNow: now, entryNet: { buyCells: [] } };
  ok(order({ ...base, mom15Pct: 0.6 }, 60, noMeasure) === order({ ...base, coin: 'D', mom15Pct: -0.1 }, 60, noMeasure),
    'без замера ключ нейтрален');
}

console.log('Сервер отдаёт ход и замер');
{
  const src = fs.readFileSync('server.js', 'utf8');
  ok(src.includes('mom15Pct: mom15,'), 'entrySignals считает ход за 15 минут');
  ok(src.includes('mom15Pct: sig.mom15Pct,'), 'ход попадает в строку скана');
  ok(src.includes('chaseNet: ENTRY_CHASE,'), 'замер отдаётся панели');
  ok(/const ENTRY_CHASE = \{\n  at: '2026-11-23'/.test(src), 'замер записан с датой');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
