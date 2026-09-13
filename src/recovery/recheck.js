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

module.exports = { distances, sampleWindows };
