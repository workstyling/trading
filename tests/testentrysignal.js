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
    assert.equal(requestOptions.signal, 10000);
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
