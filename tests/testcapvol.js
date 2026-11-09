'use strict';
// MCap и Vol24 в строке панели входа и строка комиссии счёта против цели.
const assert = require('node:assert/strict');
const view = require('../public/js/recovery-journal');

// Формат денег: крупные суммы сокращаются, неизвестное — прочерк, а не $0.
const row = { coin: 'SOL', mcap: 51061000000, vol24: 94224452 };
const html = view.recoveryCapVol(row);
assert.ok(html.includes('MCap $51.06B'), 'капитализация в миллиардах');
assert.ok(html.includes('Vol24 $94.2M'), 'объём в миллионах');
assert.ok(view.recoveryCapVol({ mcap: 1.504e12, vol24: 850e3 }).includes('MCap $1.50T'), 'триллионы');
assert.ok(view.recoveryCapVol({ mcap: 1.504e12, vol24: 850e3 }).includes('Vol24 $850K'), 'тысячи');

const unknown = view.recoveryCapVol({ coin: 'USELESS', mcap: null, vol24: 3042858 });
assert.ok(unknown.includes('MCap —'), 'нет капитализации — прочерк');
assert.ok(!unknown.includes('$0'), 'неизвестное не выдаётся за ноль');
assert.ok(view.recoveryCapVol({ mcap: 0 }).includes('MCap —'), 'ноль от каталога — тоже прочерк');
assert.ok(view.recoveryCapVolNote({ mcap: null, vol24: 1e6 }).includes('не найдена'), 'подсказка объясняет прочерк');

// Комиссия счёта: при круге Limit дороже цели об этом сказано прямо.
const scan = (fees) => ({ entryNet: { target: 0.3 }, fees });
const intro = view.recoveryFeeLine(scan({ limitPct: 0.5, marketPct: 0.9, tier: 'Intro' }));
assert.ok(intro.includes('Limit 0.5%, Market 0.9%'), 'показаны настоящие комиссии');
assert.ok(intro.includes('круг Limit 1%'), 'круг — две комиссии Limit');
assert.ok(intro.includes('меньше комиссии за круг'), 'цель меньше круга — предупреждение');
assert.ok(intro.includes('примерно на 0.7%'), 'на сколько в минус');

const cheap = view.recoveryFeeLine(scan({ limitPct: 0.075, marketPct: 0.15 }));
assert.ok(cheap.includes('круг Limit 0.15%'), 'дешёвый тариф посчитан');
assert.ok(!cheap.includes('меньше комиссии'), 'цель покрывает круг — предупреждения нет');

// Видимая строка над таблицей говорит о том же коротко.
const netScan = { entryNet: { from: '2026-09-10', to: '2026-10-05', panel: -0.246, panelSe: 0.01, control: -0.242,
  controlSe: 0.007, n: 1, controlN: 1, modes: 16, plusModes: 0, target: 0.3, buyCells: [] } };
const summary = html => (html.match(/<summary>(.*?)<span/) || [])[1] || '';
assert.ok(summary(view.renderRecoveryNet({ ...netScan, fees: { limitPct: 0.35, marketPct: 0.75 } }))
  .includes('Цель +0.3% меньше комиссии за круг 0.7%'), 'дорогой тариф виден без раскрытия');
assert.ok(!summary(view.renderRecoveryNet({ ...netScan, fees: { limitPct: 0.075, marketPct: 0.15 } })).includes('комиссии'),
  'на дешёвом тарифе видимая строка не меняется');

// Комиссии неизвестны — это не «всё в порядке».
assert.ok(view.recoveryFeeLine(scan(null)).includes('неизвестна'), 'нет данных — так и сказано');
assert.ok(view.recoveryFeeLine(scan({ limitPct: null, marketPct: 0.9 })).includes('неизвестна'), 'частичные данные — тоже неизвестно');

console.log('testcapvol: ok');
