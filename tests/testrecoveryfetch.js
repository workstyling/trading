'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const { historyReady, sampleWindows } = require('../src/recovery/recheck');
const view = require('../public/js/recovery-journal');
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

(async () => {
  const from = Date.UTC(2026, 8, 9), to = from + 48 * 3600000;
  const sparse = Array.from({ length: 500 }, (_, i) => ({
    t: from / 1000 + 6600 + i * 300, lo: 99, hi: 101, cl: 100,
  }));
  assert(!historyReady(sparse, from, to), 'unverified sparse cache needs a download');
  assert(historyReady(sparse, from, to, true), 'successful queries can include intervals without trades');
  assert(!historyReady(sparse.slice(0, 20), from, to, true), 'a tiny history remains unusable');
  const samples = sampleWindows(sparse, { from, to });
  assert(samples.length > 0);
  const first = samples[0];
  const gap = sparse.filter(c => c.t * 1000 !== first.at + 300000);
  assert(!sampleWindows(gap, { from, to }).some(row => row.at === first.at), 'a missing future candle invalidates the sample');
  assert.equal(sampleWindows(sparse.slice(0, 100), { from, to }).length, 0, 'insufficient day coverage cannot produce a sample');

  const script = read('scripts/recheck-recovery.js');
  const start = script.indexOf('async function candles(');
  const end = script.indexOf('\n// Доли по монетам', start);
  const ctx = vm.createContext({ CB: 'https://example.test', H: {}, pace: 0, paceUp() {}, paceDown() {},
    sleep: async () => {}, AbortSignal, Date, Set });
  vm.runInContext(script.slice(start, end), ctx);
  let calls = 0;
  ctx.fetch = async (_url, options) => {
    assert(options.signal, 'history requests have a timeout');
    calls++;
    return { ok: true, json: async () => [] };
  };
  let result = await ctx.candles('CELR-USD', from, from + 86400000);
  assert(result.complete && result.rows.length === 0 && calls === 1, 'empty successful page is complete');
  calls = 0;
  ctx.fetch = async () => ({ ok: ++calls > 1, json: async () => [[from / 1000, 1, 2, 1, 1.5]] });
  result = await ctx.candles('CELR-USD', from, from + 86400000);
  assert(result.complete && result.rows.length === 1 && calls === 2, 'retry restores a temporary failure');
  calls = 0;
  ctx.fetch = async () => { calls++; return { ok: true, json: async () => ({ message: 'not candles' }) }; };
  result = await ctx.candles('CELR-USD', from, from + 86400000);
  assert(!result.complete && calls === 4, 'invalid response shape is not a complete download');
  calls = 0;
  ctx.fetch = async () => ({ ok: ++calls === 1, json: async () => [[from / 1000, 1, 2, 1, 1.5]] });
  result = await ctx.candles('CELR-USD', from, from + 2 * 86400000);
  assert(!result.complete && result.rows.length === 1, 'one failed page invalidates completeness of the whole request');

  const server = read('server.js');
  const signalStart = server.indexOf('async function entrySignals(');
  const signalEnd = server.indexOf('\n}', signalStart) + 2;
  const signalCtx = vm.createContext({ DIP_CB: '', Date, cbTry: async () => null });
  vm.runInContext(server.slice(signalStart, signalEnd), signalCtx);
  let why = '';
  assert.equal(await signalCtx.entrySignals('ZAMA', reason => { why = reason; }), null);
  assert(why.includes('повторных запросов'));
  signalCtx.cbTry = async () => ({ json: async () => [] });
  await signalCtx.entrySignals('ZAMA', reason => { why = reason; });
  assert(why.includes('не менее 30'));
  signalCtx.cbTry = async () => ({ json: async () => Array.from({ length: 30 }, () => [1, 1, 2, 1, 1]) });
  await signalCtx.entrySignals('ZAMA', reason => { why = reason; });
  assert(why.includes('20 минут'));

  // Manual diagnostics can run quietly without disabling scheduled alerts.
  let child, spawned = 0, notified = 0, written;
  const recheckCtx = vm.createContext({ Date, JSON, RECHECK_STAMP: 'unused', RECOVERY_CHECK_VERSION: 2,
    ...require('../src/recovery/check-state'),
    RECHECK_EVERY_H: 22, recheckStamp: () => ({}), __dirname: '.', process: { execPath: 'node' },
    console: { log() {}, error() {} }, fs: { writeFileSync: (_file, text) => { written = JSON.parse(text); } },
    sendTelegram: async () => { notified++; }, require: name => {
      assert.equal(name, 'child_process');
      return { spawn: () => { spawned++; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; } };
    } });
  const rstart = server.indexOf('let recoveryRecheckActive = false;');
  const rend = server.indexOf('\n// Проверяем часто', rstart);
  vm.runInContext(server.slice(rstart, rend), recheckCtx);
  assert.equal(recheckCtx.recoveryRecheck(true, { notify: false }), true);
  assert.equal(recheckCtx.recoveryRecheck(true), false);
  assert.equal(spawned, 1, 'parallel manual checks cannot duplicate heavy work');
  child.stdout.emit('data', 'RECHECK_RESULT {"status":"incomplete"}\n');
  await child.listeners('close')[0](2);
  assert.equal(notified, 0);
  assert.equal(written.report.status, 'incomplete', 'quiet run still persists the result');
  assert.equal(recheckCtx.recoveryRecheck(true), true);
  await child.listeners('close')[0](2);
  assert.equal(notified, 1, 'normal scheduled notifications remain enabled');

  const recentFailure = {version: 2, at: Date.now() - 10 * 60000, report: null, code: 1};
  recheckCtx.recheckStamp = () => recentFailure;
  assert.equal(recheckCtx.recoveryRecheck(false, {notify: false}), false, 'scheduler waits between retries');
  recheckCtx.recheckStamp = () => ({...recentFailure, at: Date.now() - 31 * 60000});
  assert.equal(recheckCtx.recoveryRecheck(false, {notify: false}), true, 'actual scheduler retries a failed run without waiting 22 hours');
  child.stderr.emit('data', 'Coinbase /products: HTTP 502\n');
  await child.listeners('close')[0](1);
  assert.equal(written.lastAttempt.error, 'Coinbase /products: HTTP 502', 'failure diagnostic survives the log ring');
  assert.equal(written.lastAttempt.ok, false);

  const missing = view.renderRecoveryMissing({ missed: ['ZAMA'], missedDetails: { ZAMA: '<bad>' } });
  assert(missing.includes('Текущий скан: нет данных по ZAMA'));
  assert(missing.includes('&lt;bad&gt;') && !missing.includes('<bad>'));
  assert.equal(view.renderRecoveryMissing({ missed: [] }), '');
  const opened = view.recoveryDetailsState({ querySelectorAll: () => [{ dataset: { recoveryDetail: 'rules' } }] });
  const panels = ['rules', 'quality'].map(name => ({ dataset: { recoveryDetail: name } }));
  view.restoreRecoveryDetails({ querySelectorAll: () => panels }, opened);
  assert(panels[0].open && !panels[1].open, 'refresh preserves the chosen disclosure state');
  console.log('Sparse history, bounded retries, missing reasons, quiet rechecks and disclosure state: OK');
})().catch(err => { console.error(err); process.exitCode = 1; });
