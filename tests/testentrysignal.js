const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const view = require('../public/js/recovery-journal');
const now = Date.now();
const cell = { lo: 10, deep: false, horizonH: 4, target: 2, netA: 0.31, seA: 0.1, netB: 0.28, seB: 0.09, n: 900 };
const scan = { success: true, at: now, serverNow: now, gate: { fallPct: 3, spreadPct: 0.3 },
  entryNet: { buyCells: [cell] }, results: [
    { coin: 'SIGNAL', price: 1, dayFallPct: 12, pullbackPct: 0.5, spreadPct: 0.1, chg24Pct: 1 },
  ] };
(async () => {
  for (const mobile of [false, true]) {
    const src = fs.readFileSync(mobile ? 'public/mobile/index.html' : 'public/index.html', 'utf8');
    const start = src.indexOf('    // 40 — минимальный порог, при котором превышение положительно в ОБА');
    const end = src.indexOf('    async function loadMicroScalp' + (mobile ? 'M' : '') + '() {', start);
    assert(start > 0 && end > start);
    const box = { innerHTML: '' };
    let payload = scan, requestOptions;
    const ctx = { ...view, BASE: '', trackFreshness: () => {}, trackFreshnessM: () => {},
      AbortSignal: { timeout: ms => ms },
      document: { getElementById: id => id === (mobile ? 'entryScanBoxM' : 'entryScanBox') ? box : null },
      fetch: async (url, options) => {
        if (url.includes('entry-scan')) requestOptions = options;
        return { json: async () => payload };
      } };
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end), ctx);
    const render = ctx[mobile ? 'loadEntryScanM' : 'loadEntryScan'];
    await render();
    assert(box.innerHTML.includes('брать 4ч +2%'));
    assert(box.innerHTML.includes('data-entry-state="confirmed"'));
    assert(!box.innerHTML.includes('data-entry-state="possible"'));
    assert.equal(requestOptions.signal, 10000);
    const possible = { ...scan, entryNet: { buyCells: [] }, recoveryMeasuredAt: '2026-09-09',
      recheck: { current: true, code: 1, at: now, report: {
        version: 2, status: 'drift', referenceDate: '2026-09-09',
        from: now - 3 * 86400000, to: now - 300000, missingCoins: [], cells: [
          { lo: 0, deep: false, actual: 45, se: 2, coins: 20, n: 900 },
          { lo: 10, deep: false, actual: 70, se: 2, coins: 20, n: 900 },
        ],
      } } };
    payload = possible;
    await render();
    assert(box.innerHTML.includes('data-entry-state="possible"'));
    assert(box.innerHTML.includes('кандидат'));
    assert(!box.innerHTML.includes('data-entry-state="confirmed"'));
    assert(!view.recoverySignalRows(possible.results, possible)[0].buySignal, 'orange must not authorize a purchase');
    assert(box.innerHTML.includes('>группа</small>'), 'a group estimate must be visibly identified');
    payload = { ...possible, recheck: { ...possible.recheck, report: { ...possible.recheck.report,
      cells: possible.recheck.report.cells.map(c => c.lo === 10
        ? { ...c, byCoin: { SIGNAL: { pct: 80, n: 100 } } } : c),
    } } };
    await render();
    assert(!box.innerHTML.includes('>группа</small>'), 'an individual estimate is not labelled as a group');
    assert(box.innerHTML.includes('80.0%'), 'the individual frequency is shown');
    for (const change of [{ at: now - 300001 }, { recheck: null }, { staleSince: now }, { gate: null },
      ...[{ spreadPct: null }, { spreadPct: 0.301 }, { chg24Pct: -10 }, { price: null }]
        .map(over => ({ results: [{ ...possible.results[0], ...over }] }))]) {
      payload = { ...possible, ...change };
      await render();
      assert(!box.innerHTML.includes('data-entry-state="possible"'));
      assert(!box.innerHTML.includes('data-entry-state="confirmed"'));
    }
    // A high-frequency row with no price must stay below a lower-frequency candidate.
    // A confirmed entry without an hourly estimate must remain above both.
    const mixed = { ...possible, entryNet: { buyCells: [{ ...cell, lo: 3, deep: true }] },
      results: [
        { ...scan.results[0], coin: 'NOPRICE', price: null },
        { ...scan.results[0], coin: 'CANDIDATE', dayFallPct: 7 },
        { ...scan.results[0], coin: 'BUY', dayFallPct: 4, pullbackPct: 2 },
        ...Array.from({ length: 18 }, (_, i) => ({ ...scan.results[0], coin: 'REST' + i, spreadPct: null })),
      ], recheck: { ...possible.recheck, report: { ...possible.recheck.report,
        cells: [...possible.recheck.report.cells, { lo: 6, deep: false, actual: 60, se: 2, coins: 20, n: 900 }] } } };
    payload = mixed;
    await render();
    const renderedCoins = Array.from(box.innerHTML.matchAll(/onclick="selectCoinForTradeM?\('([^']+)'\)/g), m => m[1]);
    assert.deepEqual(renderedCoins.slice(0, 3), ['BUY', 'CANDIDATE', 'NOPRICE']);
    assert.equal(renderedCoins.length, mixed.results.length, 'no coins disappear after eight rows');
    assert.equal(new Set(renderedCoins).size, mixed.results.length, 'each coin appears exactly once');
    assert(box.innerHTML.includes('Покупать · 1'));
    assert(box.innerHTML.includes('Кандидаты · покупка не разрешена · 1'));
    assert(box.innerHTML.includes('Остальные · 19'));
    assert(src.includes('tr[data-entry-state="confirmed"] { --entry-border: var(--entry-confirmed); }'));
    assert(src.includes('tr[data-entry-state="possible"] { --entry-border: var(--entry-possible); }'));
    for (const side of ['top', 'bottom', 'left', 'right']) assert(src.includes('border-' + side + ':'), side);
    payload = { success: false };
    await render();
    assert(!box.innerHTML.includes('брать 4ч +2%'));
    assert(box.innerHTML.includes('сигналы покупки отключены'));
    payload = { ...scan, at: now - 300001 };
    await render();
    assert(!box.innerHTML.includes('брать 4ч +2%'));
    payload = scan;
    await render();
    assert(box.innerHTML.includes('брать 4ч +2%'));
    ctx.fetch = async () => { throw new Error('timeout'); };
    await render();
    assert(!box.innerHTML.includes('брать 4ч +2%'));
    assert(box.innerHTML.includes('недоступна: timeout'));
    console.log((mobile ? 'Mobile' : 'Desktop') + ': signal, failed response, stale scan, recovery and timeout: OK');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
