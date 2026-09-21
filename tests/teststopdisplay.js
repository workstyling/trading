'use strict';

// Execute production normalization and mobile rendering without starting the
// application, polling Coinbase, or calling any order handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const server = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const mobile = fs.readFileSync('public/mobile/index.html', 'utf8').replace(/\r\n/g, '\n');
const desktop = fs.readFileSync('public/index.html', 'utf8').replace(/\r\n/g, '\n');
const context = vm.createContext({});
vm.runInContext(server.match(/function partialValue[\s\S]*?\n}/)[0] + '\n' +
  server.match(/function normalizeOrder[\s\S]*?\n}/)[0], context);
const normalize = context.normalizeOrder;
const raw = {order_id: 'stop-test', product_id: 'TEST-USD', side: 'SELL', status: 'OPEN',
  order_type: 'STOP_LIMIT', average_filled_price: '0.39', filled_size: '2', filled_value: '0.78',
  total_fees: '0.001', total_value_after_fees: '99'};
const config = {limit_price: '0.39457', stop_price: '0.39458', base_size: '10'};
for (const kind of ['stop_limit_stop_limit_gtc', 'stop_limit_stop_limit_gtd']) {
  const order = normalize({...raw, order_configuration: {[kind]: config}});
  assert.equal(order.limit_price, config.limit_price, kind + ' retains the actual limit');
  assert.equal(order.stop_price, config.stop_price, kind + ' keeps the trigger separate');
  assert.equal(Number(order.total_value), 0.779, 'Partial proceeds still use the executed portion');
  const filled = normalize({...raw, status: 'FILLED', order_configuration: {[kind]: config}});
  assert.equal(filled.total_value, raw.total_value_after_fees, 'Completed proceeds retain their original contract');
}
for (const kind of ['limit_limit_gtc', 'limit_limit_gtd', 'limit_limit_fok']) {
  const order = normalize({...raw, order_type: 'LIMIT', order_configuration: {[kind]: {limit_price: '0.4'}}});
  assert.equal(order.limit_price, '0.4', kind + ' still exposes its limit');
  assert.equal(order.stop_price, null, 'Normal limits have no stop trigger');
}
for (const missing of [undefined, {}, {market_market_ioc: {base_size: '10'}}]) {
  const order = normalize({...raw, order_configuration: missing});
  assert.equal(order.limit_price, null, 'Absent limit stays unknown');
  assert.equal(order.stop_price, null, 'Absent trigger stays unknown');
}

const latestLoop = mobile.match(/filtered\.forEach\(\(o, i\) => \{[\s\S]*?\n      \}\);/)[0];
const monitorLoop = mobile.match(/\/\/ Individual orders\n        orders\.forEach\(o => \{[\s\S]*?\n        \}\);/)[0];
const desktopLoop = desktop.slice(desktop.indexOf('const orderIdShort = orderId ?'), desktop.indexOf('// Cancel button handlers'));
const desktopRow = 'orders.forEach((o, i) => { const orderId = o.order_id;\n' + desktopLoop.slice(0, desktopLoop.indexOf("\n      h += '</tbody></table>';"));
function render(source, order, variable = 'html') {
  const ctx = vm.createContext({filtered: [order], orders: [order], selectedOrders: [], totalFilled: 8,
    pair: 'TEST-USD', fmt: String, fmtPrice: String, tradingSettings: {sellMarkup: 1},
    window: {__orderPosCache: {}}, orderBaseSize: () => '10'});
  return vm.runInContext('let ' + variable + " = '';\n" + source + '\n' + variable, ctx);
}
const stop = normalize({...raw, order_configuration: {stop_limit_stop_limit_gtc: config}});
for (const [name, source, variable] of [['mobile latest', latestLoop, 'html'],
  ['mobile selected', monitorLoop, 'html'], ['desktop latest', desktopRow, 'h']]) {
  const html = render(source, stop, variable);
  assert.ok(html.includes(config.limit_price), name + ' shows limit even after partial execution');
  assert.ok(html.includes(config.stop_price), name + ' shows separate stop');
  assert.ok(!html.includes('class="order-pos"'), name + ' does not imply an unconfirmed stop is resting in the book');
  assert.ok(!/NaN|Infinity/.test(html), name + ' has finite display values');
  const regular = render(source, {...stop, order_type: 'LIMIT', stop_price: null}, variable);
  assert.ok(regular.includes('class="order-pos"'), name + ' keeps the normal limit book position');
}

// The desktop harness runs the actual renderer, live quote callback and hover,
// including the reported screenshot and stop-loss / missing-price regressions.
process.stdout.write(execFileSync(process.execPath, ['scripts/verify-price-progress.js'], {encoding: 'utf8'}));
if (process.argv.includes('--fixture')) {
  const css = [...mobile.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  fs.writeFileSync('data/stop-mobile-qa.html', '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css +
    '</style></head><body style="padding:20px 8px"><h2>Stop Limit</h2><div style="max-width:390px">' +
    '<table class="otbl"><thead><tr><th></th><th>Pair</th><th>Side</th><th>Price</th><th>Fill</th><th>Action</th></tr></thead><tbody>' +
    render(latestLoop, stop) + '</tbody></table><h3>Selected</h3><div class="monitor-group">' +
    render(monitorLoop, stop) + '</div></div></body></html>', 'utf8');
}
console.log('stop display: normalization and desktop/mobile rendering passed');
