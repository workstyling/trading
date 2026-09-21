const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { updateOrdersFreshnessStatus } = require('../public/js/orders-freshness');
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
(async () => {
  const src = read('server.js');
  const start = src.indexOf('let ordersCache =');
  const end = src.indexOf('\n// Стоимость ИСПОЛНЕННОЙ', start);
  let handler, payload, status = 200, now = Date.now(), calls = 0, fail = false;
  const orders = [{ order_id: 'test', status: 'OPEN' }];
  const ctx = vm.createContext({ Date: { now: () => now }, console: { error() {} },
    app: { get: (_url, fn) => { handler = fn; } },
    getLatestOrders: async () => { calls++; if (fail) throw new Error('502 Coinbase Error\n<html>large body</html>'); return orders; } });
  vm.runInContext(src.slice(start, end), ctx);
  const request = async (fresh = false) => {
    status = 200;
    await handler({ query: fresh ? { fresh: '1' } : {} }, {
      status(code) { status = code; return this; }, json(body) { payload = body; },
    });
    return payload;
  };
  fail = true;
  await request();
  assert.equal(status, 500);
  assert.equal(payload.stale, true);
  assert.equal(payload.updatedAt, null);
  assert(!payload.error.includes('<html>'));
  fail = false;
  await request();
  const updatedAt = payload.updatedAt;
  assert.equal(payload.stale, false);
  assert.equal(payload.orders, orders);
  now += 1000;
  await request();
  assert.equal(calls, 2, 'fresh cache avoids another exchange call');
  assert.equal(payload.updatedAt, updatedAt, 'reading cache does not change its timestamp');
  fail = true;
  await request(true);
  assert.equal(calls, 3, 'fresh=1 bypasses cache');
  assert.equal(payload.stale, true, 'failed forced refresh is explicitly stale even within cache TTL');
  assert.equal(payload.updatedAt, updatedAt);
  assert.equal(payload.orders, orders, 'an exchange failure preserves the previous orders');
  await request();
  assert.equal(calls, 4, 'normal polling must retry after a failed forced refresh, even within cache TTL');
  assert.equal(payload.stale, true);
  now += 10000;
  await request();
  assert.equal(payload.stale, true);
  fail = false;
  await request();
  assert.equal(payload.stale, false, 'successful refresh clears the stale flag');
  assert.equal(payload.updatedAt, now);

  for (const mobile of [false, true]) {
    const html = read(mobile ? 'public/mobile/index.html' : 'public/index.html');
    assert(html.includes('src="/js/orders-freshness.js"'));
    assert(html.includes('id="ordersFreshness" role="status" hidden'));
    const name = mobile ? 'loadOrders' : 'loadLatestOrders';
    const begin = html.indexOf('    async function ' + name + '(');
    const finish = html.indexOf('\n    }', begin) + 6;
    const warning = { hidden: true, textContent: '' };
    let result, timeout;
    const context = vm.createContext({ allOrders: [], selectedOrders: [], prevOrderStatuses: {},
      ORDERS_SERVER: '', document: { getElementById: () => warning }, console: { warn() {} },
      AbortSignal: { timeout: ms => { timeout = ms; return {}; } }, updateOrdersFreshnessStatus,
      renderOrders() {}, renderFilteredOrders() {}, updateSelectedOrdersView() {},
      api: async () => result,
      fetch: async () => { if (result instanceof Error) throw result; return { json: async () => result }; },
    });
    vm.runInContext(html.slice(begin, finish), context);
    const load = context[name];
    result = { success: true, orders, stale: false, updatedAt };
    await load();
    assert.equal(timeout, 10000);
    assert(warning.hidden);
    result = { ...result, stale: true };
    await load();
    assert(!warning.hidden && warning.textContent.includes('сохранённый список'));
    assert(warning.textContent.includes('Последнее обновление'));
    result = mobile ? { success: false, error: 'timeout' } : new Error('timeout');
    await load();
    assert(!warning.hidden && warning.textContent.includes('недоступны'));
    assert.equal(context.allOrders, orders, 'network failure does not clear the visible order list');
    result = { success: true, orders: [], stale: false, updatedAt: now };
    await load();
    assert(warning.hidden && warning.textContent === '', 'recovery removes the warning');
    console.log((mobile ? 'Mobile' : 'Desktop') + ': stale orders, timeout and recovery: OK');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
