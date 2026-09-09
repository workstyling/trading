'use strict';

// Execute the actual desktop rendering, quote-update and hover callbacks.
// A small DOM fixture supplies only their browser dependencies; no application,
// timers, network requests, exchange clients or order handlers are started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8').replace(/\r\n/g, '\n');
function fragment(pattern, description) {
  const found = html.match(pattern);
  assert.ok(found, 'Cannot locate production ' + description + '; update the extraction anchor after refactoring.');
  return found[0];
}
const initialSource = fragment(/selectedBuyOrders\.forEach\(\(buyOrder, idx\) => \{[\s\S]*?\n        \}\);/, 'initial progress rendering');
const updateSource = fragment(/progressBars\.forEach\(progressEl => \{[\s\S]*?\n        \}\);/, 'progress quote update');
const updateSelector = fragment(/const progressBars = document\.querySelectorAll\([^\n]+\);/, 'progress quote pair selection');
const hoverSource = fragment(/document\.querySelectorAll\('\.price-progress-container'\)\.forEach\(container => \{[\s\S]*?\n      \}\);/, 'hover event wiring');
const helpers = [
  fragment(/function roundToTick\(price, dec\) \{[\s\S]*?\n    \}/, 'price rounding'),
  fragment(/function getFeeLimit\(\) \{[^\n]*\}/, 'maker fee getter'),
  fragment(/function getFeeMarket\(\) \{[^\n]*\}/, 'taker fee getter'),
  fragment(/function setText\(el, str\) \{[\s\S]*?\n    \}/, 'text update helper'),
  fragment(/function setClass\(el, cls\) \{[\s\S]*?\n    \}/, 'class update helper'),
].join('\n');

function near(actual, expected, label, tolerance = 1e-8) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    label + ': expected ' + expected + ', received ' + actual);
}
function nodeFromTag(markup, className) {
  const tag = markup.match(new RegExp('<[^>]*class="[^"\\n]*\\b' + className + '\\b[^"\\n]*"[^>]*>'));
  assert.ok(tag, 'Initial markup has ' + className);
  const style = {};
  const attribute = tag[0].match(/style="([^"]*)"/);
  for (const declaration of (attribute ? attribute[1] : '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon >= 0) style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
  }
  return { style, className: tag[0].match(/class="([^"]*)"/)[1], innerHTML: '', textContent: '',
    childNodes: [], firstChild: null, offsetWidth: 320 };
}
function progressDOM(markup, groupNode) {
  const dataset = {};
  for (const [, key, value] of markup.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
    dataset[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  const byClass = {};
  for (const name of ['price-progress-fill', 'current-marker', 'info-current', 'info-loss',
    'center-marker', 'breakeven-marker', 'target-marker', 'info-buy', 'info-target',
    'price-hover-tooltip', 'price-hover-line']) byClass[name] = nodeFromTag(markup, name);
  const handlers = {};
  const bar = {
    querySelector: selector => byClass[selector.split('.').pop()],
    getBoundingClientRect: () => ({left: 40, width: 1000}),
  };
  const container = {
    dataset,
    querySelector: selector => selector === '.price-progress-bar' ? bar : byClass[selector.split('.').pop()],
    addEventListener: (name, handler) => { handlers[name] = handler; },
    closest: selector => selector === '.coin-group' ? groupNode : null,
  };
  return {container, bar, byClass, handlers};
}
const originalOrder = {
  order_id: 'regression-order', average_filled_price: '0.45530345',
  filled_size: '1402.45', total_value: '639.50',
};
async function setup({order = originalOrder, orders = [order], visibleOrders = orders,
  group = {filled: orders.reduce((sum, item) => sum + Number(item.filled_size), 0),
    usd: orders.reduce((sum, item) => sum + Number(item.total_value), 0)},
  ask = 0.454, marketFee = 0.15, tradeFee = 0.075, tickDec = 12, coin = 'TEST'} = {}) {
  const settings = {sellMarkup: 1, marketFee, tradeFee};
  const pair = coin + '-USD';
  const context = vm.createContext({
    selectedBuyOrders: visibleOrders, pendingSell: null, coin, pair, tradingSettings: settings,
    bestAsk: ask, fmtPrice: value => String(value),
    priceTick: async () => tickDec,
    showCustomAlert: () => {},
    fetch: () => { throw new Error('Network must not be used by price-progress tests'); },
    setTimeout: () => { throw new Error('Timers must not be used by price-progress tests'); },
  });
  vm.runInContext(helpers, context);
  const markup = vm.runInContext("let h = '';\n" + initialSource + '\nh;', context);
  const groupNode = {table: group ? {dataset: {...group}} : null,
    querySelector(selector) { return selector === '.profit-table' ? this.table : null; }};
  const doms = [...markup.matchAll(/<div class="price-progress-container"[\s\S]*?(?=<div class="price-progress-container"|$)/g)]
    .map(match => progressDOM(match[0], groupNode));
  assert.equal(doms.length, visibleOrders.length, 'A separate production bar is rendered for each selected order');
  const allDoms = [...doms];
  const dom = doms[0];
  context.document = {
    querySelectorAll(selector) {
      if (selector === '.price-progress-container') return allDoms.map(item => item.container);
      const exactPair = selector.match(/^\.price-progress-container\[data-pair="([^"]+)"\]$/);
      assert.ok(exactPair, 'Quote updates select bars by exact product pair');
      return allDoms.filter(item => item.container.dataset.pair === exactPair[1]).map(item => item.container);
    },
    createElement: () => ({style: {}, select() {}}),
    body: {appendChild() {}, removeChild() {}},
    execCommand() {},
  };
  // Export the original nested function only for observations. Its body and
  // the actual mousemove handler are unchanged and both are exercised below.
  const instrumented = hoverSource.replace(/\n      \}\);$/, '\n        container.testCalcHover = calcHover;\n      });');
  assert.notEqual(instrumented, hoverSource, 'Hover function export was instrumented');
  vm.runInContext(instrumented, context);
  await Promise.resolve(); // Resolve the local tick-size fixture, without timers.
  return {
    context, dom, doms, allDoms, groupNode, markup, settings,
    update(price) {
      context.bestAsk = price;
      vm.runInContext('{\n' + updateSelector + '\n' + updateSource + '\n}', context);
    },
    hoverMarker(index = 0) {
      const current = doms[index];
      const position = parseFloat(current.byClass['current-marker'].style.left);
      const event = {clientX: 40 + position * 10};
      current.handlers.mousemove(event);
      return current.container.testCalcHover(event);
    },
  };
}

async function main() {
  const screenshot = await setup();
  const first = screenshot.hoverMarker();
  near(first.hoverPrice, 0.454, 'Initial marker is the actual Ask, not a net-price coordinate');
  near(first.profit, -3.74276845, 'Main hover PnL uses the same taker fee as LIMIT');
  near(first.profitMaker, -3.265234225, 'Maker alternative remains separately available');
  const tooltip = screenshot.dom.byClass['price-hover-tooltip'].innerHTML;
  assert.ok(tooltip.includes('−$3.74'), 'The primary tooltip amount has an explicit negative sign');
  assert.ok(tooltip.includes('−$3.27'), 'The tooltip also includes the maker alternative');
  near(first.groupProfit, first.profit, 'One full selected order agrees with the selected position');

  const initialPosition = parseFloat(screenshot.dom.byClass['current-marker'].style.left);
  const initialBreakeven = parseFloat(screenshot.dom.byClass['breakeven-marker'].style.left);
  screenshot.update(0.454);
  near(parseFloat(screenshot.dom.byClass['current-marker'].style.left), initialPosition,
    'Initial and quote-update marker positions agree for actual market-buy cost');
  near(parseFloat(screenshot.dom.byClass['breakeven-marker'].style.left), initialBreakeven,
    'Initial and quote-update breakeven positions agree');
  near(screenshot.hoverMarker().profit, first.profit, 'Initial and updated hover PnL agree');

  // A price drop expands the axis. The hover handler must see the new limits.
  screenshot.update(0.40);
  near(screenshot.hoverMarker().hoverPrice, 0.40, 'Updated axis data still maps the marker to Ask');

  const breakEvenPrice = 639.5 / (1402.45 * 0.9985);
  const breakEven = await setup({ask: breakEvenPrice});
  for (const phase of ['initial', 'updated']) {
    if (phase === 'updated') breakEven.update(breakEvenPrice);
    near(breakEven.hoverMarker().profit, 0, phase + ' breakeven hover is net zero');
    assert.ok(breakEven.dom.byClass['info-current'].className.split(/\s+/).includes('profit'),
      phase + ' net breakeven is green');
    near(parseFloat(breakEven.dom.byClass['current-marker'].style.left),
      parseFloat(breakEven.dom.byClass['breakeven-marker'].style.left), phase + ' breakeven markers coincide');
  }

  const zeroFees = await setup({marketFee: 0, tradeFee: 0});
  near(zeroFees.hoverMarker().profit, -2.7877, 'Explicit zero selling fee is valid in hover');
  zeroFees.update(0.454);
  near(zeroFees.hoverMarker().profit, -2.7877, 'Explicit zero selling fee survives quote updates');
  near(zeroFees.hoverMarker().profitMaker, -2.7877, 'Explicit zero maker fee is valid');
  zeroFees.settings.marketFee = 0.15;
  zeroFees.settings.tradeFee = 0.075;
  zeroFees.update(0.454);
  near(zeroFees.hoverMarker().profit, first.profit, 'Existing handler uses changed taker settings');
  near(zeroFees.hoverMarker().profitMaker, first.profitMaker, 'Existing handler uses changed maker settings');

  // Exercise the already-wired handler after a partial-sale/data refresh.
  Object.assign(screenshot.dom.container.dataset, {
    filled: '10', spent: '4', buyPrice: '0.5', leftMax: '-20', rightMax: '20', sellFee: '0',
  });
  screenshot.settings.marketFee = 0;
  const refreshedEvent = {clientX: 540};
  const refreshed = screenshot.dom.container.testCalcHover(refreshedEvent);
  screenshot.dom.handlers.mousemove(refreshedEvent);
  near(refreshed.hoverPrice, 0.5, 'Existing handler rereads buy price and axis data');
  near(refreshed.profit, 1, 'Existing handler rereads size, actual cost and zero fee');
  assert.ok(screenshot.dom.byClass['price-hover-tooltip'].innerHTML.includes('+$1.00'),
    'Existing mousemove handler renders refreshed PnL');

  const xanOrders = [
    {order_id: 'xan001-order', average_filled_price: '0.01171', filled_size: '55212.60', total_value: '647.02'},
    {order_id: 'xan002-order', average_filled_price: '0.01181768', filled_size: '109218.80', total_value: '1292.65'},
  ];
  const xan = await setup({orders: xanOrders, ask: 0.01165, tickDec: 5, coin: 'XAN'});
  const xanFirst = xan.hoverMarker(0), xanSecond = xan.hoverMarker(1);
  const groupAtAsk = 164431.4 * 0.01165 * 0.9985 - 1939.67;
  near(xanFirst.hoverPrice, 0.01165, 'First XAN order marker uses Ask');
  near(xanSecond.hoverPrice, 0.01165, 'Second XAN order marker uses the same Ask');
  assert.notEqual(xanFirst.profit.toFixed(2), xanSecond.profit.toFixed(2), 'Different original lots have different order PnL');
  near(xanFirst.profit + xanSecond.profit, groupAtAsk, 'Two complete unmuted buys sum to the selected position');
  near(xanFirst.groupProfit, groupAtAsk, 'First order shows the group LIMIT at the same price');
  near(xanSecond.groupProfit, groupAtAsk, 'Second order shows the same group LIMIT');
  near(xanFirst.groupProfitMaker, 164431.4 * 0.01165 * 0.99925 - 1939.67, 'Group maker alternative uses group quantity');
  assert.ok(xan.dom.byClass['price-hover-tooltip'].innerHTML.includes('Ордер #xan001'), 'Tooltip identifies its order');
  assert.ok(xan.dom.byClass['price-hover-tooltip'].innerHTML.includes('Вся выбранная позиция'), 'Tooltip separates the aggregate result');

  const hidden = await setup({orders: xanOrders, visibleOrders: [xanOrders[0]], ask: 0.01165, tickDec: 5, coin: 'XAN'});
  near(hidden.hoverMarker().groupProfit, groupAtAsk, 'Hiding the second bar does not remove its selected position exposure');

  // Muting changes the selected-position dataset, independently of visible bars.
  Object.assign(xan.groupNode.table.dataset, {filled: '55212.60', usd: '647.02'});
  near(xan.hoverMarker(1).groupProfit, xanFirst.profit, 'A visible muted bar uses the remaining unmuted group totals');
  // Selected sell proceeds reduce both remaining units and net cash invested.
  Object.assign(xan.groupNode.table.dataset, {filled: '114431.4', usd: '1359.67'});
  const afterSale = xan.hoverMarker(0);
  near(afterSale.groupProfit, 114431.4 * 0.01165 * 0.9985 - 1359.67, 'Existing hover rereads updated quantity and sell proceeds');
  assert.ok(Math.abs(afterSale.groupProfit - xanFirst.profit - xanSecond.profit) > 0.01,
    'After a sale group PnL is not a sum of original BUY bars');
  Object.assign(xan.groupNode.table.dataset, {filled: '10', usd: '-1'});
  near(xan.hoverMarker().groupProfit, 10 * 0.01165 * 0.9985 + 1, 'Recovered costs may leave negative net cash invested');
  xan.groupNode.table = null;
  assert.equal(xan.hoverMarker().groupProfit, null, 'Missing selected-position data does not invent a zero group result');
  assert.equal(xan.hoverMarker().groupProfitMaker, null, 'Missing group data also hides maker aggregate');
  assert.ok(!xan.dom.byClass['price-hover-tooltip'].innerHTML.includes('Вся выбранная позиция'), 'Missing group is omitted from tooltip');

  const other = await setup({coin: 'XANOTHER', ask: 0.454});
  const otherBefore = other.dom.byClass['current-marker'].style.left;
  hidden.allDoms.push(other.dom);
  hidden.update(0.0115);
  near(hidden.hoverMarker().hoverPrice, 0.0115, 'Requested pair is updated');
  assert.equal(other.dom.byClass['current-marker'].style.left, otherBefore, 'Prefix-sharing coin is not updated with another coin quote');
  for (const clientX of [40, 1040]) {
    hidden.dom.handlers.mousemove({clientX});
    const center = parseFloat(hidden.dom.byClass['price-hover-tooltip'].style.left);
    assert.ok(center >= 160 && center <= 840, 'Tooltip is clamped inside the bar at either edge');
  }

  const fixtureIndex = process.argv.indexOf('--fixture');
  if (fixtureIndex >= 0) {
    const fixturePath = process.argv[fixtureIndex + 1];
    assert.ok(fixturePath, '--fixture requires an output path');
    const css = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
    const fixtureCode = 'const tradingSettings = ' + JSON.stringify(xan.settings) + ';\n' +
      'const priceTick = async () => 5;\nfunction showCustomAlert(text) { document.getElementById("copyResult").textContent = text; }\n' +
      helpers + '\n' + hoverSource;
    fs.writeFileSync(fixturePath, '<!doctype html><html><head><meta charset="utf-8"><title>Price progress regression fixture</title><style>' +
      css + '\nbody{display:block;padding:70px 24px;min-height:600px}.coin-group{max-width:760px;margin:40px auto}.fixture-heading{font-size:14px;margin-bottom:70px}</style></head><body>' +
      '<div class="coin-group"><div class="fixture-heading">XAN · Ask $0.01165 · 164431.4 units · $1939.67 invested</div>' +
      '<table class="profit-table" data-pair="XAN-USD" data-filled="164431.4" data-usd="1939.67"></table>' +
      xan.markup + '<div id="copyResult"></div></div><script>' + fixtureCode + '</script></body></html>', 'utf8');
    console.log('Browser fixture: ' + fixturePath);
  }

  console.log('price-progress: production render/update/hover, fee changes, multi-order/group PnL and exact-pair regressions passed');
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
