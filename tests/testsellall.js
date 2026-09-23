// Real UI functions, fake Coinbase: never creates or cancels a live order.
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const read = path => fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const extract = (source, name) => {
  const start = source.indexOf('    async function ' + name + '(');
  assert(start >= 0, name);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
};
const balances = (available, hold) => [{ currency: 'AURORA', available, hold }];

async function checkUi(mobile) {
  const html = read(mobile ? 'public/mobile/index.html' : 'public/index.html');
  const helper = mobile ? 'sellableSizeM' : 'sellableSize';
  const ask = mobile ? 'sellAtAsk' : 'sellAtCurrentAsk';
  const all = mobile ? 'sellAllAtAskM' : 'sellAllCoin';
  const requests = [], confirmations = [], errors = [];
  let response, httpOk = true, approve = true;
  const post = async (url, opts) => {
    assert.equal(url, '/create-sell-order');
    requests.push({ url, body: JSON.parse(opts.body) });
    return { success: true };
  };
  const ctx = vm.createContext({
    AbortSignal, console, fmt: String, fmtSize: String, fmtPriceForOrder: String,
    balancesCache: balances(0.01, 33630.57), coinBalances: balances(0.01, 33630.57),
    lastPricesCache: {}, monitorPriceCache: {},
    tradingSettings: { tradeFee: 0.1, marketFee: 0.15 },
    cbGet: async () => ({ ask: '0.097138' }),
    fetch: async (url, opts) => {
      if (opts?.method === 'POST') return { json: async () => post(url, opts) };
      assert.equal(url, '/get-balances?fresh=1');
      assert(opts.signal, 'balance request is bounded');
      if (response instanceof Error) throw response;
      return { ok: httpOk, json: async () => response };
    },
    api: post,
    confirmTrade: async html => { confirmations.push(html); return approve; },
    showConfirmModal: (title, html, yes, no) => { confirmations.push(title + html); (approve ? yes : no)(); },
    showOrderError: (title, html) => errors.push(title + html),
    showCustomAlert() {}, toast() {}, setTimeout: fn => fn(),
    selectedOrders: [], loadOrders: async () => {}, updateMonitor() {},
    loadLatestOrders: async () => {}, loadUsdBalance() {},
  });
  for (const name of [helper, ask, all]) vm.runInContext(extract(html, name), ctx);
  const run = async (wallet, extra = {}) => {
    requests.length = confirmations.length = errors.length = 0;
    response = { success: true, stale: false, balances: wallet, ...extra };
    await ctx[all]('AURORA-USD', '33630.56', 0.09669, 3256.71);
  };

  await run(balances(33630.57, 0));
  assert.equal(requests.length, 1);
  assert.equal(Number(requests[0].body.size), 33630.56, 'fresh full balance overrides cached free dust');
  assert.equal(confirmations.length, 1, 'only the full-sale confirmation');
  assert.match(confirmations[0], /33630\.56/);

  for (const [free, held] of [[0.01, 33630.57], [10000, 23630.58], [0, 33630.58]]) {
    await run(balances(free, held));
    assert.equal(requests.length, 0, 'SELL ALL never turns into a partial sale of held funds');
    assert.equal(confirmations.length, 0, 'no partial-sale offer');
    assert.match(errors.join(' '), /Продать всё сейчас нельзя/);
    assert(errors.join(' ').includes(String(held)), 'held amount is explained');
  }

  // Partially sold/cancelled orders can leave a smaller wallet with no holds.
  await run(balances(33000, 0));
  assert.equal(Number(requests[0].body.size), 33000);
  assert.equal(confirmations.length, 2, 'reduced amount is explicitly approved before submitting');
  await run(balances(0.01, 0));
  assert.equal(requests.length, 0, 'dust instead of a selected position is refused even without a hold');

  for (const wallet of [[], balances(null, 0), balances(33630.57, null), balances('bad', 0), balances(33630.57, -1)]) {
    await run(wallet);
    assert.equal(requests.length, 0, 'missing or malformed balance cannot permit a sale');
    assert.equal(errors.length, 1);
  }
  for (const extra of [{ stale: true }, { success: false }]) {
    await run(balances(33630.57, 0), extra);
    assert.equal(requests.length, 0);
    assert.match(errors[0], /Баланс не проверен/);
  }
  httpOk = false;
  await run(balances(33630.57, 0));
  assert.equal(requests.length, 0);
  httpOk = true;
  response = new Error('timeout'); errors.length = 0;
  await ctx[all]('AURORA-USD', '33630.56', 0.09669, 3256.71);
  assert.equal(requests.length, 0);
  assert.match(errors[0], /Баланс не проверен/);
  approve = false;
  await run(balances(33630.57, 0));
  assert.equal(requests.length, 0, 'declining confirmation cannot place an order');

  // All-position market and stop/limit buttons must use the same hold protection.
  const grouped = mobile ? ['sellAllMarketM', 'sellStopInlineM'] : ['sellAllMarket', 'sellAllLimit', 'sellStopInline'];
  for (const name of grouped) {
    assert.match(extract(html, name), /await sellableSizeM?\(coin, size, \{ requireAll: true \}\)/, name);
  }
  assert(html.includes('onclick="' + all + '('), 'visible SELL ALL button calls the tested wrapper');
  console.log((mobile ? 'Mobile' : 'Desktop') + ': full sale, held dust, partial fills, fresh balance, failure and decline: OK');
}

async function checkBalanceApi() {
  const source = read('server.js');
  const begin = source.indexOf("app.get('/get-balances'");
  const end = source.indexOf("\napp.get('/get-holdings'", begin);
  let handler, now = 100000, calls = 0, fail = false, payload;
  let current = balances(0.01, 33630.57);
  const ctx = vm.createContext({
    Date: { now: () => now }, balancesCache: { data: null, ts: 0 }, BALANCES_CACHE_TTL: 15000,
    app: { get: (url, fn) => { assert.equal(url, '/get-balances'); handler = fn; } },
    fetchAccountBalances: async () => { calls++; if (fail) throw new Error('offline'); return current; },
  });
  vm.runInContext(source.slice(begin, end), ctx);
  const request = async fresh => { await handler({ query: fresh ? { fresh: '1' } : {} }, { json: data => { payload = data; } }); return payload; };
  fail = true;
  await request(true);
  assert.equal(payload.success, false);
  assert.equal(payload.stale, true);
  fail = false;
  await request();
  assert.equal(calls, 2);
  const updatedAt = payload.updatedAt;
  now += 1000;
  await request();
  assert.equal(calls, 2, 'normal polling can use a valid cache');
  assert.equal(payload.updatedAt, updatedAt);
  current = balances(33630.57, 0);
  await request(true);
  assert.equal(calls, 3, 'sale check bypasses the still-valid old hold cache');
  assert.equal(payload.balances[0].available, 33630.57);
  const refreshedAt = payload.updatedAt;
  fail = true;
  await request(true);
  assert.equal(payload.stale, true);
  assert.equal(payload.updatedAt, refreshedAt, 'failed refresh never renews cached values');
  await request();
  assert.equal(calls, 5, 'polling retries after failed forced refresh');
  assert.equal(payload.stale, true);
  fail = false;
  now += 1000;
  await request();
  assert.equal(payload.stale, false);
  assert.equal(payload.updatedAt, now);

  let listResponse = { accounts: [] };
  const accountCtx = vm.createContext({ client: { listAccounts: async () => listResponse } });
  const fnStart = source.indexOf('async function fetchAccountBalances()');
  vm.runInContext(source.slice(fnStart, source.indexOf('\n// Pre-fetch', fnStart)), accountCtx);
  listResponse = { error: 'upstream failure' };
  await assert.rejects(accountCtx.fetchAccountBalances(), /did not return account balances/);
  listResponse = { accounts: [], has_next: true };
  await assert.rejects(accountCtx.fetchAccountBalances(), /incomplete account list/);
  listResponse = { accounts: [{ currency: 'AURORA', available_balance: { value: '0.01' } }] };
  await assert.rejects(accountCtx.fetchAccountBalances(), /invalid account balance/);
  listResponse.accounts[0].hold = { value: '33630.57' };
  const wallet = await accountCtx.fetchAccountBalances();
  assert.equal(wallet[0].available, 0.01);
  assert.equal(wallet[0].hold, 33630.57);
  for (const match of source.matchAll(/balanceCache\.ts = 0;/g)) {
    assert.match(source.slice(match.index, match.index + 80), /balancesCache\.ts = 0;/, 'trade/cancel invalidates coin balances too');
  }
  console.log('Balances API: forced refresh, marked stale fallback, retry, malformed accounts and trade invalidation: OK');
}

(async () => {
  await checkUi(false);
  await checkUi(true);
  await checkBalanceApi();
})().catch(error => { console.error(error); process.exitCode = 1; });
