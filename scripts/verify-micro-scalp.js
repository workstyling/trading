const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { calcMicroScore } = require('../src/micro-scalp/scanner');
const { createMicroLab } = require('../src/micro-scalp/lab');

async function main() {
const now = Date.now();
const goodSignal = {
  rsi5: 52,
  rsiMin30m: 43,
  aboveEma9: true,
  emaStack: true,
  rsiRecovery: true,
  pullbackPct: 0.6,
  pullbackOk: true,
  volumeX: 1.1,
  volumeOk: true,
};
const goodRegime = { above: true, distPct: 0.4, at: now };
const passed = calcMicroScore(goodSignal, 3e6, 0.1, goodRegime);
assert.equal(passed.pass, true, 'all micro checks must be required for a Paper setup');
assert.equal(passed.score, 100, 'a passing micro setup must have an unambiguous score');
assert.equal(passed.passed, passed.checks.length, 'passed count must match the checks');

const noSpread = calcMicroScore(goodSignal, 3e6, null, goodRegime);
assert.equal(noSpread.pass, false, 'unknown spread must block a Paper entry');
assert.ok(noSpread.score < 85, 'a non-passing micro setup must not look like an entry');

const staleBtc = calcMicroScore(goodSignal, 3e6, 0.1, { ...goodRegime, at: now - 6 * 60 * 1000 });
assert.equal(staleBtc.pass, false, 'stale BTC regime must block a Paper entry');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-scalp-test-'));
const journalFile = path.join(tempDir, 'journal.json');
let quote = { ask: 100, bid: 99.9, spreadPct: 0.1, at: Date.now() };
const execution = {
  targetPct: 1,
  slPct: 1,
  maxHoldMin: 60,
  feePct: 0.00125,
  executionModel: 'test',
};
try {
  const lab = createMicroLab({
    file: journalFile,
    runtimeFingerprint: 'test-fingerprint',
    getDiskFingerprint: () => 'test-fingerprint',
    getExecution: () => execution,
    fetchQuote: async () => ({ ...quote, at: Date.now() }),
    maxOpen: 1,
    maxEntrySpreadPct: 0.2,
  });
  const candidate = { coin: 'TEST', pair: 'TEST-USD', pass: true, score: 100, checks: [] };
  await lab.tick({ results: [candidate], scanAt: Date.now() });
  assert.equal(lab.payload().currentOpenCount, 1, 'a passing candidate should create one Paper trade');

  quote = { ask: 101.2, bid: 101.1, spreadPct: 0.1, at: Date.now() };
  await lab.tick({ results: [], scanAt: 0 });
  const payload = lab.payload();
  assert.equal(payload.currentClosedCount, 1, 'the target quote should close the Paper trade');
  assert.equal(payload.closed[0].why, 'TP', 'target exit must be labelled TP');
  assert.ok(payload.closed[0].pnlPct > 0, 'target PnL must include fees and remain positive');
  assert.equal(payload.open.length, 0, 'closed Paper trades must not remain open');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('micro scalp checks and isolated Paper journal: OK');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
