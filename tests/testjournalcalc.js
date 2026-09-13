const assert = require('assert');
const journal = require('../src/recovery/journal');
const { sampleWindows, distances } = require('../src/recovery/recheck');
const { renderEntryJournal } = require('../public/js/recovery-journal');
const HOUR = 3600000;
const t = (at, m60, extra = {}) => ({ at, entry: 100, m60, hit60: null, hitKnown60: true, ...extra });

// Unequal sizes: the scan-mean SE was 1; the trade-weighted influence SE is
// 4*100/(101^2), rounded to 0.039. Both the estimate and its weights matter.
const unequal = [...Array.from({ length: 100 }, () => t(0, 1)), t(HOUR, -1)];
const group = journal.summarize(unequal);
assert.equal(group.m60, 0.98);
assert.equal(group.m60seScan, 0.039);
const unknown = journal.summarize([t(0, null, { hitKnown60: false }), t(HOUR, 0.5, { hit60: 2 })]);
assert.equal(unknown.m60n, 1);
assert.equal(unknown.m60Unknown, 1);
assert.equal(unknown.hitN, 1);
assert.equal(unknown.hitUnknown, 1);
assert.equal(unknown.m60seHour, null);
for (const value of [null, undefined, '', NaN, Infinity, true]) assert.equal(journal.finite(value), false);

// The same market shock must cancel from the difference, and periods with
// only one group must not silently enter the comparison.
const main = [], control = [];
for (let h = 1; h <= 30; h++) {
  const shock = (h % 3) - 1;
  main.push(t(h * HOUR, shock + 2));
  control.push(t(h * HOUR + 60000, shock, { cv: 2 }));
}
main.push(t(80 * HOUR, 999));
control.push(t(90 * HOUR, -999, { cv: 2 }));
control.push(t(HOUR, -999, { cv: 1 }));
const compare = journal.comparison(main, control);
assert.equal(compare.hours, 30);
assert.equal(compare.n, 30);
assert.equal(compare.controlN, 30);
assert.equal(compare.diff, 2);
assert.equal(compare.se, 0);
assert.equal(compare.excludedMain, 1);
assert.equal(journal.comparison(main, control.filter(x => x.cv === 1)).n, 0);

const raw = Array.from({ length: 65 }, (_, i) => [i * 60, 99.9, 100.1, 100, 100, 1]);
let result = journal.candleOutcome(t(0, 0), raw);
assert.equal(result.m60, 0);
assert.equal(result.hit60, null);
assert.equal(result.hitKnown60, true);
result = journal.candleOutcome(t(0, 0), raw.filter((_, i) => i !== 30));
assert.equal(result.m60, 0);
assert.equal(result.hitKnown60, false);
assert.equal(result.mae60, null);
const future = raw.map(x => [...x]);
future[60] = [3600, 99.9, 110, 100, 110, 1];
assert.equal(journal.candleOutcome(t(0, 0), future).m60, 0);
assert.equal(journal.candleOutcome(t(0, 0), future).hit60, null);
future[4] = [240, 99.9, 101, 100, 100.5, 1];
assert.equal(journal.candleOutcome(t(0, 0), future).m5, 0.5);
assert.equal(journal.candleOutcome(t(0, 0), future).hit60, 5);
assert.equal(journal.candleOutcome(t(0, 0), []).hitKnown60, false);
assert.equal(journal.candleOutcome(t(0, 0), []).m60, null);
assert.equal(journal.candleOutcome(t(30000, 0), [[0, 99, 105, 100, 100, 1]]).hit60, null);

const odds = (fall, pull) => ({ hour: pull >= 1.5 ? 89 : 78 });
let cells = journal.forecastCells([
  t(0, 0, { dayFall: 12, pullback: 2, recHour: 89, recHourAtOpen: 75, hit60: 4 }),
  t(HOUR, 0, { dayFall: 12, pullback: 0.2, recHour: 78 }),
], odds);
assert.equal(cells.length, 2);
assert.equal(cells.find(x => x.current === 89).promised, 75);
assert.equal(cells.find(x => x.current === 89).actual, 100);
assert.equal(cells.find(x => x.current === 78).actual, 0);
cells = journal.forecastCells([t(0, null, { dayFall: 12, pullback: 2, hitKnown60: false })], odds);
assert.equal(cells[0].actual, null);
assert.equal(cells[0].actualLow, 0);
assert.equal(cells[0].actualHigh, 100);

assert.equal(distances(120, 101.5, 100).pull, 1.5);
const candles = Array.from({ length: 1441 }, (_, i) => ({ t: i * 300, lo: 99, hi: 101.5, cl: 100 }));
const end = 1441 * 300000;
const sampled = sampleWindows(candles, { from: end - 2 * 86400000, to: end });
assert(sampled.length > 0);
assert(sampled[0].at >= end - 2 * 86400000);
assert.equal(sampled[sampled.length - 1].at + HOUR, end);
assert(sampled.every(x => x.pull === 1.5));
assert.equal(sampleWindows(candles, { from: end, to: end }).length, 0);
const html = renderEntryJournal({ comparison: compare, byVerdict: { брать: unknown } });
assert(!html.includes('+null') && !html.includes('NaN'));
assert(html.includes('без издержек'));
assert(html.includes('30 общих ч'));
console.log('Weighted journal, common periods, candle coverage and boundaries, historical window, forecast cells, rendering: OK');
const { renderRecoveryStatus } = require('../public/js/recovery-journal');
assert(renderRecoveryStatus(null).includes('ещё не завершена'));
assert(renderRecoveryStatus({ current: false, report: { status: 'no-drift' } }).includes('ещё не завершена'));
assert(renderRecoveryStatus({ current: true, report: { status: 'drift' } }).includes('не подтверждены'));
assert(renderRecoveryStatus({ current: true, report: { status: 'incomplete' } }).includes('мало наблюдений'));
assert(renderRecoveryStatus({ current: true, report: { status: 'no-drift' } }).includes('прибыльность не проверялась'));
