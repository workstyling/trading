'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8').replace(/\r\n/g, '\n');
const state = html.slice(html.indexOf("const BAR_SELECTED_KEY ="), html.indexOf('// ========== TRACKED ORDERS'));
const saved = new Map([['barSelectedOrders', JSON.stringify({TEST: 'older-buy'})]]);
let writes = 0;
function boot() {
  const context = vm.createContext({safeStorage: {
    getItem: key => saved.get(key),
    setItem: (key, value) => {writes++; saved.set(key, value);},
  }});
  vm.runInContext(state, context);
  return context;
}
const ctx = boot();
const buy = (order_id, fields = {}) => ({order_id, product_id: 'TEST-USD', side: 'BUY', status: 'OPEN',
  filled_size: '0', average_filled_price: '0', ...fields});
const filled = (id, fields = {}) => buy(id, {status: 'FILLED', filled_size: '10', average_filled_price: '0.4', ...fields});
const bars = () => JSON.parse(saved.get('barSelectedOrders'));
ctx.autoSelectFilledBars([buy('new-buy')]);
assert.equal(writes, 0, 'No bar before an actual fill');
ctx.autoSelectFilledBars([filled('older-buy'), filled('new-buy'), filled('second-buy'),
  filled('partial-buy', {status: 'OPEN', filled_size: '2'})]);
assert.deepEqual(bars().TEST, ['older-buy', 'new-buy', 'second-buy', 'partial-buy'],
  'Every newly filled purchase gets its bar, including partial execution and an existing coin');
assert.equal(writes, 2, 'One persisted update for the whole render');
ctx.autoSelectFilledBars([filled('new-buy')]);
assert.equal(writes, 2, 'Refresh does not duplicate bars or rewrite storage');

// Persist the state written by the real bar click handler.
vm.runInContext("barManualChoices['new-buy'] = false; barSelectedOrders.TEST = barSelectedOrders.TEST.filter(id => id !== 'new-buy'); saveBarSelection();", ctx);
ctx.autoSelectFilledBars([filled('new-buy')]);
assert.ok(!bars().TEST.includes('new-buy'), 'Manual hide survives the next render');
const reloaded = boot();
reloaded.autoSelectFilledBars([filled('new-buy'), filled('partial-buy')]);
assert.ok(!bars().TEST.includes('new-buy'), 'Manual hide survives page reload');
assert.equal(bars().TEST.filter(id => id === 'partial-buy').length, 1, 'Final execution does not add a second bar');
for (const bad of [null, undefined, '', 'NaN', 'Infinity', '-1', '0']) {
  ctx.autoSelectFilledBars([filled('bad-price', {average_filled_price: bad}), filled('bad-size', {filled_size: bad})]);
}
ctx.autoSelectFilledBars([filled('sale', {side: 'SELL'}), filled('', {}), filled('no-pair', {product_id: null})]);
assert.ok(!bars().TEST.some(id => ['sale', 'bad-price', 'bad-size', ''].includes(id)), 'Invalid data and sales cannot enable a buy bar');
assert.ok(html.includes('autoSelectFilledBars(selected);'), 'Selected-order rendering applies defaults on every fill refresh');
assert.ok(html.includes('barManualChoices[orderId] = isNowActive;'), 'Real selector records both manual on and off choices');
console.log('auto bars: all buys, partial fills, repeat refreshes, legacy state, manual hide/reload and missing data passed');
