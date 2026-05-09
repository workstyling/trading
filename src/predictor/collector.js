// Fetches historical OHLCV candles from Coinbase Exchange public API.
// Supported granularities: 60, 300, 900, 3600, 21600, 86400 seconds.
// Coinbase returns at most 300 candles per request, so we paginate when needed.

const fetch = require('node-fetch');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchPage(symbol, granularitySec, startSec, endSec) {
  const url = `https://api.exchange.coinbase.com/products/${symbol}-USD/candles` +
    `?granularity=${granularitySec}` +
    (startSec ? `&start=${new Date(startSec * 1000).toISOString()}` : '') +
    (endSec ? `&end=${new Date(endSec * 1000).toISOString()}` : '');
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`Coinbase ${r.status}: ${await r.text().catch(()=>'')}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error('Unexpected response');
    // Coinbase rows: [time, low, high, open, close, volume] — newest first
    return data.map(row => ({
      t: row[0] * 1000,
      low: row[1], high: row[2], open: row[3], close: row[4], volume: row[5],
    })).sort((a, b) => a.t - b.t);
  }
  return [];
}

// Fetch up to `count` recent candles. Paginates back if count > 300.
async function fetchHistorical(symbol, granularitySec, count) {
  const out = [];
  let endSec = Math.floor(Date.now() / 1000);
  // Round down to candle boundary
  endSec = endSec - (endSec % granularitySec);
  let remaining = count;
  while (remaining > 0) {
    const pageSize = Math.min(300, remaining);
    const startSec = endSec - pageSize * granularitySec;
    const page = await fetchPage(symbol, granularitySec, startSec, endSec);
    if (!page.length) break;
    out.unshift(...page);
    remaining -= page.length;
    endSec = startSec;
    if (page.length < pageSize) break;
    await sleep(250); // be nice to the API
  }
  // De-dup just in case (page boundaries can overlap)
  const map = new Map();
  for (const c of out) map.set(c.t, c);
  return Array.from(map.values()).sort((a, b) => a.t - b.t);
}

module.exports = { fetchHistorical };
