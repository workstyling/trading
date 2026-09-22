'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {nextCheckAt, finishCheck, usableCheck} = require('../src/recovery/check-state');
const {fetchMetadata} = require('../src/recovery/recheck');
const view = require('../public/js/recovery-journal');
const now = Date.now(), minute = 60000, hour = 60 * minute;
const report = {version: 2, status: 'drift', referenceDate: '2026-09-09',
  from: now - 10 * 86400000, to: now - hour - 300000, coins: 50, missingCoins: [], cells: [
    {lo: 0, deep: false, actual: 50, se: 1, coins: 40},
    {lo: 3, deep: false, actual: 75, se: 1, coins: 40},
  ]};
const previous = {version: 2, at: now - hour, code: 1, report};
assert.equal(usableCheck(previous), true, 'Code 1 with a drift report is a completed check');
const failed = {version: 2, at: now, code: 1, report: null, startedAt: now - 1000};
assert.equal(usableCheck(failed), false, 'Same code 1 without a report is a failure');
assert.equal(nextCheckAt(previous), previous.at + 22 * hour, 'Completed result uses the normal interval');
assert.equal(nextCheckAt(failed), now + 30 * minute, 'Fast startup failure retries in 30 minutes, not 22 hours');
assert.equal(nextCheckAt({...failed, startedAt: now + 1000}), now + 1000 + 40 * minute, 'An interrupted run retains the restart lock');
assert.equal(nextCheckAt({}), 0, 'A new installation can start immediately');
const saved = finishCheck(previous, {report: null, code: 1, startedAt: now - 5000, at: now, error: 'HTTP 502'});
assert.equal(saved.report, previous.report, 'Failure preserves a usable earlier report');
assert.equal(saved.at, previous.at, 'Preservation never resets the report clock');
assert.equal(saved.code, previous.code, 'Code stays paired with the retained report');
assert.equal(saved.lastAttempt.ok, false);
assert.equal(saved.lastAttempt.error, 'HTTP 502');
assert.equal(nextCheckAt(saved), now + 30 * minute);
assert.equal(usableCheck(saved, report.to + 49 * hour), false, 'Old report still expires');
const expired = {...previous, at: now - 49 * hour, report: {...report, to: now - 49 * hour}};
assert.equal(finishCheck(expired, {report: null, code: 1, at: now, startedAt: now, error: 'timeout'}).report,
  null, 'An expired report is not revived after a failure');
const recovered = finishCheck(saved, {report: {...report, status: 'incomplete'}, code: 2, at: now + minute, startedAt: now});
assert.equal(recovered.lastAttempt.ok, true, 'A valid incomplete result recovers service');
assert.equal(recovered.lastAttempt.error, null);
assert.equal(nextCheckAt(recovered), now + minute + 22 * hour);
assert.equal(finishCheck(previous, {report, code: 0, at: now, startedAt: now}).lastAttempt.ok, false,
  'Mismatched exit code cannot make a report valid');

const row = {coin: 'TEST', price: 1, dayFallPct: 4, pullbackPct: 0.5, chg24Pct: 2, spreadPct: 0.05, inListMin: 1};
const scan = {serverNow: now, at: now, results: [row], gate: {fallPct: 3, spreadPct: 0.3},
  recoveryMeasuredAt: report.referenceDate, recheck: {...previous, current: true}, entryNet: {buyCells: []}};
const unavailable = {...scan, recheck: {...failed, current: true, lastAttempt: saved.lastAttempt, nextAt: now + 30 * minute}};
const unknown = view.renderRecoveryGroups([row], unavailable, r => r.coin, 7);
assert.ok(unknown.includes('покупка не разрешена · —'));
assert.ok(unknown.includes('Кандидаты не определены'));
assert.ok(!unknown.includes('Сейчас нет кандидатов.'));
const validEmpty = view.renderRecoveryGroups([{...row, dayFallPct: 0.5}], scan, r => r.coin, 7);
assert.ok(validEmpty.includes('покупка не разрешена · 0'));
assert.ok(validEmpty.includes('Сейчас нет кандидатов.'));
assert.ok(view.renderRecoveryGroups([row], scan, r => r.coin, 7).includes('покупка не разрешена · 1'));
assert.ok(view.renderRecoveryStatus({...unavailable.recheck, running: true}, now).includes('Пересчёт статистики'));
assert.ok(view.renderRecoveryStatus({...unavailable.recheck, running: false}, now).includes('через 30 мин'));
assert.ok(view.renderRecoveryStatus({...unavailable.recheck, lastAttempt: {...saved.lastAttempt, error: '<bad>'}}, now).includes('&lt;bad&gt;'));

// Run both real panel renderers to ensure an unavailable count is not changed
// back into zero in either layout, while all coins remain visible.
(async () => {
  for (const mobile of [false, true]) {
    const src = fs.readFileSync(mobile ? 'public/mobile/index.html' : 'public/index.html', 'utf8');
    const start = src.indexOf('    // 40 — минимальный порог, при котором превышение положительно в ОБА');
    const end = src.indexOf('    async function loadMicroScalp' + (mobile ? 'M' : '') + '() {', start);
    const box = {innerHTML: ''};
    const context = vm.createContext({...view, BASE: '', AbortSignal, trackFreshness() {}, trackFreshnessM() {},
      document: {getElementById: id => id === (mobile ? 'entryScanBoxM' : 'entryScanBox') ? box : null},
      fetch: async () => ({json: async () => ({...unavailable, success: true, total: 1})})});
    vm.runInContext(src.slice(start, end), context);
    await context[mobile ? 'loadEntryScanM' : 'loadEntryScan']();
    assert.ok(box.innerHTML.includes('Кандидаты не определены'), (mobile ? 'Mobile' : 'Desktop') + ' explains missing assessment');
    assert.ok(box.innerHTML.includes('data-entry-state="none"'), 'Unknown is never a candidate');
  }
  const wait = async () => {};
  let calls = 0;
  const valid = data => Array.isArray(data) && data.length > 0;
  const data = await fetchMetadata('https://example.test/products', valid, {wait, fetchImpl: async (_url, opts) => {
    assert.ok(opts.signal, 'Metadata fetch is time-bounded');
    calls++;
    if (calls === 1) return {ok: false, status: 502};
    if (calls === 2) return {ok: true, json: async () => {throw Error('HTML, not JSON');}};
    if (calls === 3) return {ok: true, json: async () => []};
    return {ok: true, json: async () => ['BTC-USD']};
  }});
  assert.equal(calls, 4);
  assert.deepEqual(data, ['BTC-USD']);
  calls = 0;
  await assert.rejects(fetchMetadata('https://example.test/products/stats', valid, {wait, fetchImpl: async () => {
    calls++; throw Error('network timeout');
  }}), /Coinbase \/products\/stats: network timeout/);
  assert.equal(calls, 4, 'Persistent failures cannot loop forever');
  console.log('Recovery failures: bounded metadata retries, retained timestamps, retry schedule, both layouts and recovery passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
