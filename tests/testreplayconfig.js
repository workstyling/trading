'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const filename = path.resolve('src/scalp/validate-gate.js');
const source = fs.readFileSync(filename, 'utf8').split('(async () => {')[0];
const realRequire = createRequire(filename);
function setup(fee) {
  const context = {
    __dirname: path.dirname(filename),
    process: { argv: ['node', filename, '30', '500000', '110', fee] },
    require: name => name === 'fs' ? {
      readFileSync: file => JSON.stringify(path.basename(file) === 'settings.json'
        ? { tradeFee: 0.075 } : { targetPct: 2, slPct: 6 }),
    } : realRequire(name),
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.exitConfig = configuredExit; this.excluded = STABLE;', context);
  return context;
}
assert.equal(setup().exitConfig().feeSidePct, 0.075, 'default still follows local settings');
assert.equal(setup('0.1').exitConfig().feeSidePct, 0.1, 'explicit deployment fee overrides local settings');
assert.equal(setup('0').exitConfig().feeSidePct, 0, 'zero fee is explicit and valid');
for (const value of ['', 'unknown', '-1', '100', 'Infinity']) {
  assert.throws(() => setup(value).exitConfig(), /feeSidePct/, 'invalid override must not silently fall back');
}
const { STABLE } = require('../src/scalp/scanner');
assert.equal(setup().excluded, STABLE, 'replay and scanner use the same exclusion list');
for (const coin of ['USD1', 'RLUSD', 'USDG', 'ALUSD', 'MUSD']) assert.ok(setup().excluded.has(coin), coin);
console.log('Replay configuration: all checks passed');
