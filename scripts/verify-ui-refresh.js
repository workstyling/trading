'use strict';

// Browser regressions for the production DOM refresh helpers. This serves only
// extracted UI code and synthetic orders on loopback; server.js is never loaded.
// Run: node scripts/verify-ui-refresh.js [--port 3998]
// Open the printed URL. Assertions appear in #results and GET /results.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

function readSource(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
}
function fragment(source, pattern, description) {
  const found = source.match(pattern);
  assert.ok(found, 'Cannot locate production ' + description + '; update the extraction anchor after refactoring.');
  return found[0];
}
function helper(source, name) {
  return fragment(source, new RegExp('function ' + name + '\\([^\\n]*\\) \\{[\\s\\S]*?\\n    \\}'), name);
}

function browserAssertions() {
  const checks = [];
  function check(condition, name) {
    checks.push({pass: !!condition, name});
  }
  function assertSame(actual, expected, name) {
    check(actual === expected, name);
  }
  const desktop = document.getElementById('desktop');
  const mobile = document.getElementById('mobile');
  const coin = 'TEST';
  const pair = coin + '-USD';
  const orderId = 'regression-order';
  const selectedBuyOrders = [{order_id: orderId, average_filled_price: '0.7676', filled_size: '577.85', total_value: '444.22'}];
  const pendingSell = null;
  const tradingSettings = {sellMarkup: 1, marketFee: 0.15, tradeFee: 0.075};
  let bestAsk = 0.7516;
  let selectedOrders = [orderId];
  const barSelectedOrders = {TEST: [orderId]};
  let savedSelections = 0, savedBars = 0, renderedBars = 0, copiedPrices = 0;
  const saveSelectedOrders = () => { savedSelections++; };
  const saveBarSelection = () => { savedBars++; };
  const updateSelectedOrdersView = () => { renderedBars++; };
  const showCustomAlert = () => { copiedPrices++; };
  const priceTick = async () => 4;
  const fmtPrice = value => String(value);
  // The copy callback is exercised without modifying the user's clipboard.
  document.execCommand = () => true;

  /* PRODUCTION_HELPERS */
  function progressMarkup() {
    let h = '';
    /* PRODUCTION_PROGRESS */
    return h;
  }
  function updateQuote() {
    /* PRODUCTION_QUOTE */
  }
  function wireControls() {
    const container = desktop;
    /* PRODUCTION_SELECTORS */
    /* PRODUCTION_HOVER */
  }
  function cardMarkup(price) {
    return '<div class="coin-group" id="coin_TEST">' +
      '<h2>TEST-USD <span id="quote">' + price + '</span></h2>' +
      '<label>Limit price <input id="limitSellPrice_TEST" value="0.751"></label>' +
      '<button class="order-selector selected" data-order-id="' + orderId + '">Selected</button>' +
      '<button class="bar-selector active" data-order-id="' + orderId + '" data-coin="TEST">Bar</button>' +
      '<table class="profit-table" data-filled="577.85" data-usd="444.22"></table>' +
      '<div id="live-info" data-live="1"></div>' + progressMarkup() + '</div>';
  }

  async function run() {
    desktop.innerHTML = cardMarkup(bestAsk);
    wireControls();
    await Promise.resolve();
    const card = desktop.querySelector('.coin-group');
    const input = desktop.querySelector('input');
    const progress = desktop.querySelector('.price-progress-container');
    const marker = progress.querySelector('.current-marker');
    const tooltip = progress.querySelector('.price-hover-tooltip');
    const hoverLine = progress.querySelector('.price-hover-line');
    const bar = progress.querySelector('.price-progress-bar');
    const selector = desktop.querySelector('.order-selector');
    const barSelector = desktop.querySelector('.bar-selector');
    const liveInfo = desktop.querySelector('#live-info');
    setLiveHtml(liveInfo, '<span class="position">Position <b>12</b></span>');
    const liveValue = liveInfo.querySelector('b');
    const rect = bar.getBoundingClientRect();
    progress.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: rect.left + rect.width / 2}));
    check(tooltip.children.length > 0 && tooltip.style.display === 'block', 'Desktop: actual hover callback populated a visible tooltip');
    const tooltipChild = tooltip.firstElementChild;
    const tooltipText = tooltip.textContent;
    const markerBefore = marker.style.left;
    input.focus();
    input.value = '0.81234';
    input.setSelectionRange(2, 5);
    const mutations = new MutationObserver(() => {});
    mutations.observe(desktop, {childList: true, subtree: true});
    let patchedEveryTime = true;
    for (let i = 1; i <= 8; i++) {
      bestAsk = 0.7516 + i * 0.0002;
      updateQuote();
      const markup = cardMarkup(bestAsk);
      const patched = patchList(desktop, markup);
      patchedEveryTime = patchedEveryTime && patched;
      // Match the production caller: a rejected patch rebuilds the list.
      if (!patched) desktop.innerHTML = markup;
      wireControls();
    }
    check(patchedEveryTime, 'Desktop: all eight list refreshes patch a populated hover tooltip');
    assertSame(desktop.querySelector('.coin-group'), card, 'Desktop: coin card identity survives refreshes');
    assertSame(desktop.querySelector('.price-progress-container'), progress, 'Desktop: progress bar identity survives refreshes');
    assertSame(desktop.querySelector('.current-marker'), marker, 'Desktop: price marker identity survives refreshes');
    assertSame(desktop.querySelector('.price-hover-tooltip'), tooltip, 'Desktop: tooltip identity survives refreshes');
    assertSame(tooltip.firstElementChild, tooltipChild, 'Desktop: populated tooltip contents survive refreshes');
    assertSame(tooltip.textContent, tooltipText, 'Desktop: list templates retain independently rendered tooltip text');
    assertSame(tooltip.style.display, 'block', 'Desktop: visible tooltip stays open during refreshes');
    assertSame(hoverLine.style.display, 'block', 'Desktop: hover line stays visible during refreshes');
    assertSame(desktop.querySelector('input'), input, 'Desktop: price input identity survives refreshes');
    assertSame(document.activeElement, input, 'Desktop: refreshes preserve focus in the price input');
    assertSame(input.value, '0.81234', 'Desktop: refreshes preserve a price being edited');
    check(input.selectionStart === 2 && input.selectionEnd === 5, 'Desktop: refreshes preserve text selection');
    assertSame(liveInfo.querySelector('b'), liveValue, 'Desktop: nested live position contents retain their nodes');
    assertSame(liveValue.textContent, '12', 'Desktop: empty outer templates do not erase live position values');
    check(marker.style.left !== markerBefore, 'Desktop: quote updates still move the existing price marker');
    assertSame(desktop.querySelector('#quote').textContent, String(bestAsk), 'Desktop: refreshes still update quote text');
    check(mutations.takeRecords().length === 0, 'Desktop: quote/list refreshes replace no child nodes');
    mutations.disconnect();
    check([progress, selector, barSelector].every(node => node.dataset.wired === '1'), 'Desktop: wiring markers survive list patching');
    desktop.querySelector('.order-selector').click();
    assertSame(savedSelections, 1, 'Desktop: one order click invokes exactly one selection handler');
    assertSame(selectedOrders.length, 0, 'Desktop: one order click toggles selection exactly once');
    desktop.querySelector('.bar-selector').click();
    check(savedBars === 1 && renderedBars === 1 && barSelectedOrders.TEST.length === 0, 'Desktop: one bar click invokes exactly one handler');
    desktop.querySelector('.price-progress-container').dispatchEvent(new MouseEvent('click', {clientX: rect.left + rect.width / 2}));
    assertSame(copiedPrices, 1, 'Desktop: one progress click invokes exactly one copy callback');
    setLiveHtml(liveInfo, '<span class="position">Position <b>9</b></span>');
    assertSame(liveInfo.querySelector('b'), liveValue, 'Desktop: direct live-content refresh preserves nested node identity');
    assertSame(liveValue.textContent, '9', 'Desktop: direct live-content refresh updates the visible value');
    setLiveHtml(liveInfo, '<em>No position</em>');
    check(liveInfo.querySelector('em')?.textContent === 'No position', 'Desktop: changed structure still replaces stale content');

    function mobileMarkup(coins, value = '2', checked = false, limit = '0.75', orderIds = ['m1', 'm2']) {
      return coins.map(name => '<section class="monitor-coin" data-coin="' + name + '">' +
        '<h2>' + name + '</h2><input id="depth_' + name + '" value="' + value + '">' +
        '<input id="check_' + name + '" type="checkbox"' + (checked ? ' checked' : '') + '>' +
        '<div class="live" data-live="1" data-pair="' + name + '-USD" data-limit="' + limit + '">...</div>' +
        orderIds.map(id => '<div class="monitor-order" data-order-id="' + name + '-' + id + '">' +
          '<span>' + id + ' quote ' + value + '</span></div>').join('') + '</section>').join('');
    }
    setLiveHtmlM(mobile, mobileMarkup(['AAA', 'BBB']));
    const coinA = mobile.querySelector('[data-coin="AAA"]');
    const coinB = mobile.querySelector('[data-coin="BBB"]');
    const inputB = coinB.querySelector('#depth_BBB');
    const orderB1 = coinB.querySelector('[data-order-id="BBB-m1"]');
    const liveB = coinB.querySelector('.live');
    liveB.innerHTML = '<span>Position <b>4</b></span>';
    const liveBValue = liveB.querySelector('b');
    inputB.focus();
    inputB.value = '12345';
    inputB.setSelectionRange(1, 4);
    const mobileMutations = new MutationObserver(() => {});
    mobileMutations.observe(mobile, {childList: true, subtree: true});
    for (let i = 3; i <= 6; i++) setLiveHtmlM(mobile, mobileMarkup(['AAA', 'BBB'], String(i)));
    assertSame(mobile.querySelector('[data-coin="BBB"]'), coinB, 'Mobile: repeated refreshes preserve coin identity');
    assertSame(coinB.querySelector('[data-order-id="BBB-m1"]'), orderB1, 'Mobile: repeated refreshes preserve order identity');
    assertSame(liveB.querySelector('b'), liveBValue, 'Mobile: repeated refreshes preserve populated live descendants');
    assertSame(inputB.value, '12345', 'Mobile: repeated refreshes preserve a focused edit');
    assertSame(document.activeElement, inputB, 'Mobile: repeated refreshes preserve input focus');
    assertSame(orderB1.textContent, 'm1 quote 6', 'Mobile: repeated refreshes update order quote text');
    check(mobileMutations.takeRecords().length === 0, 'Mobile: unchanged card/order structure replaces no child nodes');
    mobileMutations.disconnect();
    setLiveHtmlM(mobile, mobileMarkup(['BBB', 'AAA', 'CCC'], '7', true, '0.75', ['m2', 'm1', 'm3']));
    assertSame(mobile.firstElementChild, coinB, 'Mobile: coin reorder moves the original keyed card');
    assertSame(mobile.children[1], coinA, 'Mobile: adding a coin retains other keyed cards');
    assertSame(coinB.querySelectorAll('.monitor-order')[1], orderB1, 'Mobile: order reorder moves the original keyed order');
    assertSame(coinB.querySelector('#depth_BBB'), inputB, 'Mobile: coin reorder preserves input identity');
    assertSame(document.activeElement, inputB, 'Mobile: coin reorder preserves focused input');
    assertSame(inputB.value, '12345', 'Mobile: coin reorder preserves an unfinished input edit');
    check(inputB.selectionStart === 1 && inputB.selectionEnd === 4, 'Mobile: coin reorder preserves text selection');
    check(coinB.querySelector('#check_BBB').checked, 'Mobile: refresh applies checkbox state');
    assertSame(liveB.querySelector('b'), liveBValue, 'Mobile: reorder preserves live quote contents');
    inputB.blur();
    setLiveHtmlM(mobile, mobileMarkup(['BBB', 'CCC'], '8', false, '0.76', ['m1', 'm3']));
    assertSame(mobile.firstElementChild, coinB, 'Mobile: removing another coin retains the remaining card');
    check(!mobile.contains(coinA), 'Mobile: removed coins disappear');
    assertSame(coinB.querySelector('.monitor-order'), orderB1, 'Mobile: removing another order retains the remaining order');
    check(!coinB.querySelector('[data-order-id="BBB-m2"]'), 'Mobile: removed orders disappear');
    assertSame(inputB.value, '8', 'Mobile: after blur refreshed saved values are applied');
    check(!coinB.querySelector('#check_BBB').checked, 'Mobile: refresh clears checkbox state');
    check(!liveB.contains(liveBValue) && liveB.textContent === '...', 'Mobile: changed live-price parameters invalidate old position contents');
    const mixed = document.createElement('div');
    mobile.appendChild(mixed);
    setLiveHtmlM(mixed, 'old <span id="mixed-span">price</span> tail');
    const mixedSpan = mixed.querySelector('span');
    setLiveHtmlM(mixed, '<span id="mixed-span">new</span>');
    assertSame(mixed.querySelector('span'), mixedSpan, 'Mobile: removing surrounding text preserves the element');
    assertSame(mixed.textContent, 'new', 'Mobile: obsolete text nodes are removed');
    setLiveHtmlM(mixed, 'prefix <span id="mixed-span">newer</span> suffix');
    assertSame(mixed.querySelector('span'), mixedSpan, 'Mobile: inserting surrounding text preserves the element');
    assertSame(mixed.textContent, 'prefix newer suffix', 'Mobile: new text nodes appear in their correct positions');

    const failed = checks.filter(item => !item.pass);
    const result = {passed: checks.length - failed.length, failed: failed.length, checks};
    document.getElementById('results').textContent =
      (failed.length ? 'FAIL' : 'PASS') + ': ' + result.passed + '/' + checks.length + '\n' +
      checks.map(item => (item.pass ? 'PASS ' : 'FAIL ') + item.name).join('\n');
    document.body.dataset.testStatus = failed.length ? 'failed' : 'passed';
    window.__uiRefreshResults = result;
    await fetch('/results', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(result)});
  }
  run().catch(async error => {
    const result = {passed: 0, failed: 1, error: error.stack || String(error), checks};
    window.__uiRefreshResults = result;
    document.body.dataset.testStatus = 'failed';
    document.getElementById('results').textContent = 'FAIL: ' + result.error;
    await fetch('/results', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(result)});
  });
}

function buildPage() {
  const desktop = readSource('public/index.html');
  const mobile = readSource('public/mobile/index.html');
  const helperNames = ['skeletonNodes', 'sameSkeleton', 'patchNode', 'patchList', 'setLiveHtml', 'setText', 'setClass', 'roundToTick'];
  const helpers = helperNames.map(name => helper(desktop, name)).concat([
    fragment(desktop, /function getFeeLimit\(\) \{[^\n]*\}/, 'maker fee getter'),
    fragment(desktop, /function getFeeMarket\(\) \{[^\n]*\}/, 'taker fee getter'),
    ...['liveNodeKeyM', 'patchLiveNodeM', 'patchLiveChildrenM', 'setLiveHtmlM'].map(name => helper(mobile, name)),
  ]).join('\n');
  const progress = fragment(desktop, /selectedBuyOrders\.forEach\(\(buyOrder, idx\) => \{[\s\S]*?\n        \}\);/, 'progress rendering');
  const quote = fragment(desktop, /const progressBars = document\.querySelectorAll\([^\n]+\);/, 'quote selection') + '\n' +
    fragment(desktop, /progressBars\.forEach\(progressEl => \{[\s\S]*?\n        \}\);/, 'progress quote update');
  const hover = fragment(desktop, /document\.querySelectorAll\('\.price-progress-container'\)\.forEach\(container => \{[\s\S]*?\n      \}\);/, 'hover wiring');
  const selectors = ['order-selector', 'bar-selector'].map(name => fragment(desktop,
    new RegExp("container\\.querySelectorAll\\('\\." + name + "'\\)\\.forEach\\(sel => \\{[\\s\\S]*?\\n        \\}\\);"), name + ' wiring')).join('\n');
  let script = '(' + browserAssertions.toString() + ')();';
  for (const [marker, code] of Object.entries({PRODUCTION_HELPERS: helpers, PRODUCTION_PROGRESS: progress,
    PRODUCTION_QUOTE: quote, PRODUCTION_SELECTORS: selectors, PRODUCTION_HOVER: hover})) {
    script = script.replace('/* ' + marker + ' */', () => code);
  }
  new vm.Script(script, {filename: 'ui-refresh-browser.js'});
  return '<!doctype html><html><head><meta charset="utf-8"><title>UI refresh regressions</title>' +
    '<style>body{font:14px monospace;background:#10131a;color:#e9eef5;padding:20px}#results{white-space:pre-wrap}' +
    '.coin-group{padding:20px;background:#1b2030;width:760px;margin-top:20px}' +
    '.price-progress-container{position:relative;margin-top:48px}.price-progress-bar{position:relative;height:16px;background:#333}' +
    '.price-hover-tooltip{position:absolute;bottom:24px;display:none;background:#111;width:360px;padding:8px}' +
    '.price-hover-line,.price-marker{position:absolute;height:18px;width:2px;background:#ffe54c}' +
    '.price-progress-fill{position:absolute;height:8px;background:#ff6030}.price-progress-top,.price-progress-info{height:20px}' +
    'input{margin:8px}button{margin:4px}#mobile{margin-top:20px}</style></head><body>' +
    '<h1>UI refresh regressions</h1><pre id="results">Running browser assertions...</pre>' +
    '<div id="desktop"></div><div id="mobile"></div><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script></body></html>';
}

const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 3998;
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, '--port must be an integer from 0 to 65535');
// Fail fast on extraction/syntax errors before reporting a test URL.
buildPage();
let latestResults = {status: 'pending', message: 'Open the test page in a browser to run assertions.'};
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.url === '/results' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', () => {
      try {
        latestResults = JSON.parse(body);
        console.log('ui-refresh: ' + latestResults.passed + ' passed, ' + latestResults.failed + ' failed');
        for (const item of latestResults.checks || []) if (!item.pass) console.error('FAIL ' + item.name);
        if (latestResults.error) console.error(latestResults.error);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end('Invalid results'); }
    });
  } else if (req.url === '/results' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'}).end(JSON.stringify(latestResults, null, 2));
  } else if (req.url === '/' && req.method === 'GET') {
    try { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(buildPage()); }
    catch (error) { res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}).end(error.stack); }
  } else { res.writeHead(404).end('Not found'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('UI refresh browser tests: http://127.0.0.1:' + server.address().port + '/'));
