'use strict';

// Live uses rounded distances: depth from the high, rebound distance from price.
function distances(highDay, high30, price) {
  if (!(highDay > 0 && high30 > 0 && price > 0)) return null;
  return {
    fall: Math.round((highDay - price) / highDay * 10000) / 100,
    pull: Math.round((high30 / price - 1) * 10000) / 100,
  };
}

function sampleWindows(candles, { from, to, need = 0.30 }) {
  const cs = candles.filter(c => Number.isFinite(c.t) && c.t * 1000 + 300000 <= to &&
    c.lo > 0 && c.hi >= c.lo && c.cl >= c.lo && c.cl <= c.hi).sort((a, b) => a.t - b.t);
  const rows = [];
  for (let i = 0; i < cs.length; i += 3) {
    const t0 = cs[i].t, at = (t0 + 300) * 1000;
    if (at < from || at + 3600000 > to) continue;
    const day = cs.slice(Math.max(0, i - 288), i + 1).filter(c => t0 - c.t <= 86400);
    const halfHour = day.filter(c => t0 - c.t <= 1800);
    if (day.length < 30 || (t0 - day[0].t) < 20 * 3600 || halfHour.length < 2) continue;
    const future = cs.slice(i + 1, i + 13);
    // Twelve complete five-minute candles, ending at (not after) the hour.
    if (future.length !== 12 || future.some((c, j) => c.t !== t0 + (j + 1) * 300)) continue;
    const d = distances(Math.max(...day.map(c => c.hi)), Math.max(...halfHour.map(c => c.hi)), cs[i].cl);
    rows.push({ ...d, at, hit: future.some(c => c.hi >= cs[i].cl * (1 + need / 100)) });
  }
  return rows;
}

// An empty interval in a successful candle response means no trades occurred.
// It does not mean the download failed. Without verified requests, keep the
// conservative boundary checks for old cache files.
function historyReady(candles, from, to, requestsComplete = false) {
  if (!Array.isArray(candles) || candles.length < 252) return false;
  if (requestsComplete) return true;
  return candles[0].t * 1000 <= from + 3600000 &&
    to - (candles[candles.length - 1].t + 300) * 1000 <= 15 * 60000;
}

// Product metadata can fail before candle downloads even start. Bound and
// retry those requests too; HTML errors and malformed JSON are not a basket.
async function fetchMetadata(url, valid, {fetchImpl = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  let reason = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetchImpl(url, {headers: {'User-Agent': 'trading-app/1.0'}, signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!valid(data)) throw new Error('неполный или неверный ответ');
      return data;
    } catch (error) { reason = error.message; }
    if (attempt < 3) await wait([1000, 3000, 8000][attempt]);
  }
  throw new Error('Coinbase ' + new URL(url).pathname + ': ' + reason);
}

module.exports = { distances, sampleWindows, historyReady, fetchMetadata };
