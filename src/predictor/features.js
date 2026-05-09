// Feature pipeline: turns raw candles into a normalized feature vector
// suitable for both the heuristic scorer and the neural-net trainer.

const { computeAll, snapshotAt } = require('./indicators');

// Bounded squashes — keeps inputs in a small numeric range without exploding outliers.
const tanh = x => Math.tanh(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Build the feature vector for index i. Returns null if any required indicator is NaN.
function vectorAt(ind, i) {
  const s = snapshotAt(ind, i);
  if ([s.rsi14, s.macd, s.macdSignal, s.bbUpper, s.bbLower, s.ema9, s.ema21, s.ema55,
       s.atr14, s.priceChange1, s.priceChange5, s.volumeRatio].some(v => v == null || isNaN(v))) {
    return null;
  }

  // Position inside Bollinger band (0 = at lower, 1 = at upper)
  const bbRange = s.bbUpper - s.bbLower;
  const bbPos = bbRange > 0 ? clamp((s.close - s.bbLower) / bbRange, 0, 1) : 0.5;

  // EMA spreads — relative to price, then squashed
  const ema9_21 = (s.ema9 - s.ema21) / s.close;
  const ema21_55 = (s.ema21 - s.ema55) / s.close;
  const close_ema9 = (s.close - s.ema9) / s.close;

  // ATR as % of price
  const atrPct = s.atr14 / s.close;

  return [
    (s.rsi14 - 50) / 50,          // -1..1
    tanh(s.macd / s.close * 100), // squashed MACD
    tanh(s.macdHist / s.close * 100),
    bbPos * 2 - 1,                 // -1..1
    tanh(s.bbWidth * 10),
    tanh(ema9_21 * 100),
    tanh(ema21_55 * 100),
    tanh(close_ema9 * 100),
    tanh(atrPct * 100),
    tanh(s.priceChange1 * 100),
    tanh(s.priceChange5 * 100),
    tanh((s.volumeRatio - 1) / 2),
  ];
}

const FEATURE_NAMES = [
  'rsi_norm', 'macd', 'macd_hist', 'bb_pos', 'bb_width',
  'ema9_21', 'ema21_55', 'close_ema9', 'atr_pct',
  'change_1', 'change_5', 'volume_ratio',
];

const FEATURE_COUNT = FEATURE_NAMES.length;

// Build a labeled dataset for supervised training.
// Label = 1 if next candle close > current close, else 0.
function buildDataset(candles) {
  const ind = computeAll(candles);
  const X = [];
  const y = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const v = vectorAt(ind, i);
    if (!v) continue;
    const label = candles[i + 1].close > candles[i].close ? 1 : 0;
    X.push(v);
    y.push(label);
  }
  return { X, y, ind };
}

// Latest feature vector for live inference (no label needed).
function latestVector(candles) {
  const ind = computeAll(candles);
  for (let i = candles.length - 1; i >= 0; i--) {
    const v = vectorAt(ind, i);
    if (v) return { vector: v, snapshot: snapshotAt(ind, i), index: i, ind };
  }
  return null;
}

module.exports = { vectorAt, buildDataset, latestVector, FEATURE_NAMES, FEATURE_COUNT };
