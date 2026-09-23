const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// Run the production HTTP handler with a fake exchange client. No network,
// real account, or order is used by these cancellation regressions.
const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n');
const from = src.indexOf("app.post('/cancel-order'");
const end = src.indexOf('\n});', from) + 4;
assert(from >= 0 && end > from, 'cancel handler exists');
const orderId = 'test-order-123456';

async function request(exchangeReply, body = { orderId }) {
  let handler, payload, status = 200;
  const calls = [];
  const ctx = vm.createContext({
    app: { post(route, callback) { assert.equal(route, '/cancel-order'); handler = callback; } },
    client: { async cancelOrders(input) {
      calls.push(input);
      if (exchangeReply instanceof Error) throw exchangeReply;
      return exchangeReply;
    } },
    console: { log() {}, error() {} },
    ordersCache: { ts: 123 }, balanceCache: { ts: 456 }, balancesCache: { ts: 789 },
  });
  for (const name of ['hasValidOrderId', 'invalidOrderInput']) {
    const begin = src.indexOf('function ' + name + '(');
    const finish = src.indexOf('\n}', begin) + 2;
    vm.runInContext(src.slice(begin, finish), ctx);
  }
  vm.runInContext(src.slice(from, end), ctx);
  await handler({ body }, {
    status(code) { status = code; return this; },
    json(data) { payload = data; return this; },
  });
  if (calls.length) {
    assert.equal(calls.length, 1, 'cancellation is never retried blindly');
    assert.equal(calls[0].order_ids.join(), orderId, 'only the requested order is sent');
    for (const name of ['ordersCache', 'balanceCache', 'balancesCache']) {
      assert.equal(ctx[name].ts, 0, name + ' invalidated after any exchange attempt');
    }
  } else {
    assert.equal(ctx.ordersCache.ts, 123);
    assert.equal(ctx.balanceCache.ts, 456);
    assert.equal(ctx.balancesCache.ts, 789);
  }
  return { payload, status, calls };
}

(async () => {
  const success = { results: [{ order_id: orderId, success: true, failure_reason: 'UNKNOWN_CANCEL_FAILURE_REASON' }] };
  for (const response of [success, JSON.stringify(success)]) {
    const result = await request(response);
    assert.equal(result.status, 200);
    assert.equal(result.payload.success, true, 'explicit success for this order is accepted');
  }
  const failure = { results: [{ order_id: orderId, success: false, failure_reason: 'UNKNOWN_CANCEL_ORDER' }] };
  for (const response of [failure, JSON.stringify(failure)]) {
    const result = await request(response);
    assert.equal(result.status, 409);
    assert.equal(result.payload.success, false, 'HTTP 200 from Coinbase is not cancellation success');
    assert(result.payload.error.includes('UNKNOWN_CANCEL_ORDER'));
  }
  for (const reason of [{ message: 'Cannot cancel pending order' }, { error_details: 'Cancellation rejected' }]) {
    const result = await request({ results: [{ order_id: orderId, success: false, failure_reason: reason }] });
    assert.equal(result.payload.success, false);
    assert(result.payload.error.includes(reason.message || reason.error_details));
  }
  for (const response of [null, undefined, '', '{bad json', '{}', {},
    { success: true }, { results: [] }, { results: {} },
    { results: [null] }, { results: [{ success: true }] },
    { results: [{ order_id: 'another-order', success: true }] },
    { results: [{ order_id: orderId }] },
    { results: [{ order_id: orderId, success: 'true' }] },
    { results: [{ order_id: orderId, success: true }, { order_id: orderId, success: false }] },
  ]) {
    const result = await request(response);
    assert.equal(result.status, 502);
    assert.equal(result.payload.success, false, 'missing or ambiguous confirmation fails closed');
    assert(result.payload.error.includes('статус'));
  }
  const mixed = await request({ results: [
    { order_id: 'another-order', success: true },
    { order_id: orderId, success: false, failure_reason: 'CANCEL_FAILED' },
  ] });
  assert.equal(mixed.payload.success, false, 'success for another order cannot mask this order failure');

  const thrown = await request(new Error('Exchange timeout'));
  assert.equal(thrown.status, 500);
  assert.equal(thrown.payload.success, false);
  assert(thrown.payload.error.includes('Exchange timeout'));
  assert(thrown.payload.error.includes('статус'), 'uncertain outcome requires status check');

  for (const body of [undefined, {}, { orderId: '' }, { orderId: 123 }, { orderId: 'bad/id' }]) {
    const result = await request(success, body === undefined ? null : body);
    assert.equal(result.status, 400);
    assert.equal(result.payload.success, false);
    assert.equal(result.calls.length, 0, 'invalid input never reaches the exchange');
  }
  console.log('Cancel result: exact order, object/string SDK responses, failures, malformed responses and cache invalidation: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
