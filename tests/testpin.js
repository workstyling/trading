'use strict';
// Пин карточек монет (Selected Orders) и строгая лексикографичность весов
// порядка панели входа. В самой панели входа пин-кнопки нет: владелец просил
// закреплять карточки монет, а не строки рейтинга.
const fs = require('fs');
const view = require('../public/js/recovery-journal');
const { recoveryOrder } = view;
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const now = Date.now();

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

console.log('Пин карточек монет (Selected Orders) — в обеих вёрстках');
for (const file of ['public/index.html', 'public/mobile/index.html']) {
  const src = fs.readFileSync(file, 'utf8');
  ok(src.includes("togglePinnedCoin('${coin}')"), file + ': кнопка 📌 на карточке монеты');
  ok(/function coinCardRank\(coin\) \{ return pinnedCoins\.has\(coin\) \? 0 : favoriteCoins\.has\(coin\) \? 1 : 2; \}/.test(src),
    file + ': закреплённые выше избранных, избранные выше остальных');
  ok(src.includes('coinCardRank(a.split'), file + ': сортировка карточек идёт по этому порядку');
  ok(src.includes('ни на какие ордера не влияет'), file + ': закрепление описано как порядок на экране');
}

console.log('А в панели входа пин-кнопки нет');
{
  ok(!('recoveryPinButton' in view) && !('recoveryTogglePin' in view) && !('recoveryPinSet' in view),
    'помощники пина строк удалены, а не оставлены мёртвым кодом');
  for (const file of ['public/index.html', 'public/mobile/index.html']) {
    const src = fs.readFileSync(file, 'utf8');
    ok(!src.includes('recoveryPinButton'), file + ': в строках рейтинга кнопки нет');
    ok(/renderRecoveryGroups\(ranked, j, cell, [47]\)/.test(src), file + ': группы рейтинга без закреплённых');
  }
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
