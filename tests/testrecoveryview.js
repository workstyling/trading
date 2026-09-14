const assert = require('assert');
const { recoveryObservation, recoveryVerdict, recoveryDayChange, renderRecoveryStatus } = require('../public/js/recovery-journal');
const now = Date.now();
const row = { dayFallPct: 4, pullbackPct: 0.9, chg24Pct: 4.25, spreadPct: 0.1, recovery: { hour: 89 } };
const report = { version: 2, status: 'drift', referenceDate: '2026-09-09',
  from: now - 3 * 86400000, to: now - 300000, missingCoins: [], cells: [
    { lo: 3, deep: false, actual: 54.214, se: 2.6, coins: 29, n: 813 },
    { lo: 3, deep: true, thin: true, coins: 3 },
  ] };
const check = { at: now, code: 1, current: true, report };
const scan = { recheck: check, recoveryMeasuredAt: '2026-09-09', at: now };
const measure = (data = scan, coin = row) => recoveryObservation(coin, data, now);
assert.equal(measure().hour, 54.2);
assert(measure().why.includes('813'));
assert.equal(measure(scan, { ...row, pullbackPct: 1.5 }).hour, null);
// Прочерк без объяснения не отличить от поломки: он обязан называть, чего не
// хватает и почему это пройдёт. Клетки с откатом от 1.5% пусты не потому, что
// сигнала нет, а потому что окну наблюдений неполные четверо суток.
{
  const thin = measure(scan, { ...row, pullbackPct: 1.5 }).why;
  assert(thin.includes('монет 3 из 12'), thin);
  assert(/окно наблюдений 3 сут и растёт/.test(thin), thin);
  assert(/7-14 суток/.test(thin), thin);
  // Клетки нет в отчёте вовсе — тоже с числом, а не молча
  const none = measure(scan, { ...row, dayFallPct: 6 }).why;
  assert(none.includes('монет 0 из 12'), none);
  // И в шапке видно, насколько длинное окно: от него зависят все прочерки
  assert(/Окно наблюдений 3 сут и растёт/.test(renderRecoveryStatus(check, now)),
    renderRecoveryStatus(check, now));
}
assert.equal(measure(scan, { ...row, dayFallPct: 6 }).hour, null);
assert.equal(measure(scan, { ...row, dayFallPct: null }).hour, null);
assert.equal(measure(scan, { ...row, pullbackPct: '' }).hour, null);
for (const change of [
  { recheck: null }, { recoveryMeasuredAt: 'other-rule' }, { staleSince: now - 1000 }, { at: now - 6 * 60000 },
  { recheck: { ...check, current: false } }, { recheck: { ...check, code: 0 } },
  { recheck: { ...check, at: now - 49 * 3600000 } },
  { recheck: { ...check, report: { ...report, to: now - 49 * 3600000 } } },
  { recheck: { ...check, report: { ...report, missingCoins: ['BTC'] } } },
  { recheck: { ...check, report: { ...report, version: 3 } } },
  { recheck: { ...check, report: { ...report, to: now + 300000 } } },
  { recheck: { ...check, report: { ...report, from: -1e30 } } },
  { recheck: { ...check, report: { ...report, referenceDate: 'invalid' } } },
]) assert.equal(measure({ ...scan, ...change }).hour, null);
for (const change of [{ actual: null }, { actual: true }, { actual: -1 }, { actual: 101 }, { se: null }, { coins: 11 }, { thin: true }]) {
  const bad = { ...report.cells[0], ...change };
  assert.equal(measure({ ...scan, recheck: { ...check, report: { ...report, cells: [bad] } } }).hour, null);
}
assert.equal(recoveryDayChange(row), '+4.25%');
assert.equal(recoveryDayChange({ chg24Pct: null, dayFallPct: 16.35 }), '—');
assert.equal(recoveryDayChange({ chg24Pct: 0 }), '0%');
assert.equal(recoveryDayChange({ chg24Pct: -5 }), '-5%');
assert.equal(recoveryVerdict(row, { fall: 3, spread: 0.3 }, measure()).label, 'наблюдать');
assert.equal(recoveryVerdict(row, { fall: 3, spread: 0.3 }, { hour: null }).label, 'нет оценки');
assert.equal(recoveryVerdict(row, {}, measure()).tier, 0);
assert(renderRecoveryStatus(null).includes('прочерк'));
assert(renderRecoveryStatus(check).includes('Показаны свежие наблюдения'));
assert(renderRecoveryStatus({ ...check, code: 2, report: { ...report, status: 'incomplete' } }).includes('данных мало'));
assert(renderRecoveryStatus({ ...check, code: 0, report: { ...report, status: 'no-drift' } }).includes('прибыльность отбора не подтверждена'));
console.log('Fresh observations, missing cells, stale checks, daily change and non-actionable labels: OK');
