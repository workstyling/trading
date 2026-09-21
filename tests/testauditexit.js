'use strict';
// Run the real CLI bodies with simulated HTTP replies. A printed FAIL must
// also fail automation; a warming scanner must never look like a passed audit.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');

const row = () => ({ coin: 'TEST', score: 11, pass: false, passed: 3,
  tag: 'WAIT', rangePos: 0.5, rsi: 50, vol24: 600000, spreadPct: 0.1,
  checks: [
    { k: 'RSI', ok: false }, { k: 'EMA9', ok: false },
    { k: 'Диапазон', v: '4', ok: true }, { k: 'пампа', v: '0', ok: true },
    { k: 'вершиной', v: '-5', ok: true },
  ] });
const scan = () => ({ success: true, total: 60, scanned: 60, agoSec: 10,
  regime: { above: true, ret7: 1, distPct: 0, at: Date.now() - 120000 },
  watch: false, watchLoop: false, results: [row()] });
const lab = () => ({ success: true, enabled: true, fingerprint: '0123456789ab',
  closedCount: 0, currentClosedCount: 0, staleClosedCount: 0,
  brief: 'The saved validation is for other gate code (saved for old, running new). ' + 'Details. '.repeat(50) });

async function run(file, overrides = {}) {
  const replies = {
    '/api/scalp-scan': scan(), '/api/lab': lab(),
    '/products/BTC-USD/candles': Array.from({ length: 25 }, (_, i) => [i, 100, 100, 100, 100]),
    '/get-settings': { settings: { telegramConfigured: true, sellMarkup: 1 } },
    '/api/paper': { success: true, targetPct: 2, slPct: 6 }, ...overrides,
  };
  const proc = { exitCode: 0 };
  const context = { process: proc, setTimeout: fn => fn(),
    console: { log() {}, error() {} },
    fetch: async url => {
      const data = replies[new URL(url).pathname];
      if (data instanceof Error) throw data;
      return { ok: data !== undefined, status: data === undefined ? 503 : 200, json: async () => data };
    },
  };
  await vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return proc.exitCode;
}

(async () => {
  for (const file of ['scripts/audit-live.js', 'scripts/verify-score.js']) {
    assert.equal(await run(file), 0, file + ': valid response passes');
    assert.equal(await run(file, { '/api/scalp-scan': undefined }), 1, file + ': unavailable endpoint fails');
    assert.equal(await run(file, { '/api/scalp-scan': { ...scan(), success: false } }), 1, file + ': API failure fails');
    assert.equal(await run(file, { '/api/scalp-scan': { ...scan(), running: true } }), 2, file + ': warmup is inconclusive');
    assert.equal(await run(file, { '/api/scalp-scan': { ...scan(), results: [{ ...row(), pass: true }] } }), 1,
      file + ': low score cannot authorize entry even when formula matches');
  }
  assert.equal(await run('scripts/audit-live.js', { '/products/BTC-USD/candles': null }), 1, 'unexpected calculation error fails');
  assert.equal(await run('scripts/audit-live.js', { '/products/BTC-USD/candles': [] }), 1, 'empty BTC history must not pass the audit');
  const hour = Math.floor(Date.now() / 3600000) * 3600;
  const moving = Array.from({ length: 40 }, (_, i) => [hour - (39 - i) * 3600, 99, 105, 100, i === 39 ? 105 : 100]);
  const captured = { ...scan(), regime: { above: true, ret7: 1, price: 101, distPct: 0.9, at: Date.now() } };
  assert.equal(await run('scripts/audit-live.js', { '/api/scalp-scan': captured, '/products/BTC-USD/candles': moving }), 0,
    'moving open candle is compared on the scanner price, not a later price');
  assert.equal(await run('scripts/audit-live.js', {
    '/api/scalp-scan': { ...captured, regime: { ...captured.regime, distPct: 2 } }, '/products/BTC-USD/candles': moving,
  }), 1, 'an incorrect BTC calculation still fails on the same snapshot');
  assert.equal(await run('scripts/audit-live.js', { '/api/lab': { ...lab(), brief: 'Details. '.repeat(50) } }), 1,
    'missing validation explanation fails');
  assert.equal(await run('scripts/audit-live.js', { '/api/lab': {
    ...lab(), historical: { overall: { n: 40 } }, brief: 'Historical validation for this fingerprint: n=40. ' + 'Details. '.repeat(50),
  } }), 0, 'matching historical evidence is recognized');
  assert.equal(await run('scripts/verify-score.js', { '/api/scalp-scan': {
    ...scan(), results: [...Array.from({ length: 20 }, row), { ...row(), score: 74 }],
  } }), 1, 'a wrong score beyond the first twenty is checked');
  console.log('Audit CLI exit codes: all checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
