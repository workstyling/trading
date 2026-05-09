// Pure-JS technical indicators — no external deps.
// All functions take an array of OHLCV candles: { open, high, low, close, volume }
// and return an array (one value per candle, NaN where not enough history).

function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      // seed with SMA
      let s = 0;
      for (let j = 0; j <= i; j++) s += values[j];
      prev = s / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    !isNaN(emaFast[i]) && !isNaN(emaSlow[i]) ? emaFast[i] - emaSlow[i] : NaN
  );
  // Signal = EMA of macd line (only over its non-NaN tail)
  const startIdx = macdLine.findIndex(v => !isNaN(v));
  const signalLine = new Array(closes.length).fill(NaN);
  if (startIdx >= 0) {
    const tail = macdLine.slice(startIdx);
    const sigTail = ema(tail, signal);
    for (let i = 0; i < sigTail.length; i++) signalLine[startIdx + i] = sigTail[i];
  }
  const hist = macdLine.map((v, i) =>
    !isNaN(v) && !isNaN(signalLine[i]) ? v - signalLine[i] : NaN
  );
  return { macd: macdLine, signal: signalLine, hist };
}

function bollinger(closes, period = 20, mult = 2) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  const width = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const m = middle[i];
    const variance = slice.reduce((a, b) => a + (b - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    width[i] = m !== 0 ? (upper[i] - lower[i]) / m : 0;
  }
  return { middle, upper, lower, width };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const tr = new Array(candles.length).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// Compute the full indicator block for an array of candles.
// Returns parallel arrays + a helper that yields the latest snapshot.
function computeAll(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const rsi14 = rsi(closes, 14);
  const m = macd(closes, 12, 26, 9);
  const bb = bollinger(closes, 20, 2);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema55 = ema(closes, 55);
  const atr14 = atr(candles, 14);
  const volSma20 = sma(volumes, 20);

  const priceChange1 = closes.map((c, i) =>
    i > 0 ? (c - closes[i - 1]) / closes[i - 1] : NaN
  );
  const priceChange5 = closes.map((c, i) =>
    i >= 5 ? (c - closes[i - 5]) / closes[i - 5] : NaN
  );
  const volumeRatio = volumes.map((v, i) =>
    !isNaN(volSma20[i]) && volSma20[i] > 0 ? v / volSma20[i] : NaN
  );

  return {
    closes, volumes,
    rsi14,
    macd: m.macd, macdSignal: m.signal, macdHist: m.hist,
    bbUpper: bb.upper, bbMiddle: bb.middle, bbLower: bb.lower, bbWidth: bb.width,
    ema9, ema21, ema55,
    atr14,
    priceChange1, priceChange5, volumeRatio,
  };
}

// Snapshot of latest indicator values at index i.
function snapshotAt(ind, i) {
  return {
    close: ind.closes[i],
    rsi14: ind.rsi14[i],
    macd: ind.macd[i],
    macdSignal: ind.macdSignal[i],
    macdHist: ind.macdHist[i],
    bbUpper: ind.bbUpper[i],
    bbMiddle: ind.bbMiddle[i],
    bbLower: ind.bbLower[i],
    bbWidth: ind.bbWidth[i],
    ema9: ind.ema9[i],
    ema21: ind.ema21[i],
    ema55: ind.ema55[i],
    atr14: ind.atr14[i],
    priceChange1: ind.priceChange1[i],
    priceChange5: ind.priceChange5[i],
    volumeRatio: ind.volumeRatio[i],
  };
}

module.exports = { sma, ema, rsi, macd, bollinger, atr, computeAll, snapshotAt };
