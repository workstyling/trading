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
const hoverSource = fragment(/document\.querySelectorAll\('\.price-progress-container'\)\.forEach\(container => \{[\s\S]*?\n      \}\);/, 'hover event wiring');
const helpers = [
  fragment(/function roundToTick\(price, dec\) \{[\s\S]*?\n    \}/, 'price rounding'),
  fragment(/function getFeeLimit\(\) \{[^\n]*\}/, 'maker fee getter'),
  fragment(/function getFeeMarket\(\) \{[^\n]*\}/, 'taker fee getter'),
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
  return { style, className: tag[0].match(/class="([^"]*)"/)[1], innerHTML: '', textContent: '' };
}
function progressDOM(markup) {
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
  };
  return {container, bar, byClass, handlers};
}
const originalOrder = {
  order_id: 'regression-order', average_filled_price: '0.45530345',
  filled_size: '1402.45', total_value: '639.50',
};
async function setup({order = originalOrder, ask = 0.454, marketFee = 0.15, tradeFee = 0.075} = {}) {
  const settings = {sellMarkup: 1, marketFee, tradeFee};
  const context = vm.createContext({
    selectedBuyOrders: [order], pendingSell: null, coin: 'TEST', tradingSettings: settings,
    bestAsk: ask, fmtPrice: value => String(value),
    priceTick: async () => 12,
    showCustomAlert: () => {},
    fetch: () => { throw new Error('Network must not be used by price-progress tests'); },
    setTimeout: () => { throw new Error('Timers must not be used by price-progress tests'); },
  });
  vm.runInContext(helpers, context);
  const markup = vm.runInContext("let h = '';\n" + initialSource + '\nh;', context);
  const dom = progressDOM(markup);
  context.document = {
    querySelectorAll: () => [dom.container],
    createElement: () => ({style: {}, select() {}}),
    body: {appendChild() {}, removeChild() {}},
    execCommand() {},
  };
  context.progressBars = [dom.container];
  // Export the original nested function only for observations. Its body and
  // the actual mousemove handler are unchanged and both are exercised below.
  const instrumented = hoverSource.replace(/\n      \}\);$/, '\n        container.testCalcHover = calcHover;\n      });');
  assert.notEqual(instrumented, hoverSource, 'Hover function export was instrumented');
  vm.runInContext(instrumented, context);
  await Promise.resolve(); // Resolve the local tick-size fixture, without timers.
  return {
    context, dom, markup, settings,
    update(price) { context.bestAsk = price; vm.runInContext(updateSource, context); },
    hoverMarker() {
      const position = parseFloat(dom.byClass['current-marker'].style.left);
      const event = {clientX: 40 + position * 10};
      dom.handlers.mousemove(event);
      return dom.container.testCalcHover(event);
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
  assert.ok(tooltip.split('</span>')[0].includes('-3.74'), 'The primary tooltip amount is -$3.74');
  assert.ok(tooltip.includes('-3.27'), 'The tooltip also includes the maker alternative');

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

  const zeroFees = await setup({marketFee: 0});
  near(zeroFees.hoverMarker().profit, -2.7877, 'Explicit zero selling fee is valid in hover');
  zeroFees.settings.marketFee = 0.15; // Stored zero must not fall through to a nonzero default.
  zeroFees.update(0.454);
  near(zeroFees.hoverMarker().profit, -2.7877, 'Explicit zero selling fee survives quote updates');

  // Exercise the already-wired handler after a partial-sale/data refresh.
  Object.assign(screenshot.dom.container.dataset, {
    filled: '10', spent: '4', buyPrice: '0.5', leftMax: '-20', rightMax: '20', sellFee: '0',
  });
  const refreshedEvent = {clientX: 540};
  const refreshed = screenshot.dom.container.testCalcHover(refreshedEvent);
  screenshot.dom.handlers.mousemove(refreshedEvent);
  near(refreshed.hoverPrice, 0.5, 'Existing handler rereads buy price and axis data');
  near(refreshed.profit, 1, 'Existing handler rereads size, actual cost and zero fee');
  assert.ok(screenshot.dom.byClass['price-hover-tooltip'].innerHTML.split('</span>')[0].includes('1.00'),
    'Existing mousemove handler renders refreshed PnL');

  console.log('price-progress: production render/update/hover regressions passed');
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
