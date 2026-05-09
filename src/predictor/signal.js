// Combines neural-net probability + heuristic technical scoring into a single signal.
// Returns BUY / SELL / HOLD with confidence, SL/TP based on ATR, and risk/reward.

function heuristicScore(snap) {
  // Each rule contributes ±points; final score in roughly -100..+100
  let score = 0;

  // RSI: oversold = bullish, overbought = bearish
  if (snap.rsi14 < 30) score += 25;
  else if (snap.rsi14 < 40) score += 12;
  else if (snap.rsi14 > 70) score -= 25;
  else if (snap.rsi14 > 60) score -= 12;

  // MACD histogram momentum
  if (snap.macdHist > 0 && snap.macd > snap.macdSignal) score += 18;
  else if (snap.macdHist < 0 && snap.macd < snap.macdSignal) score -= 18;

  // EMA stack (9 > 21 > 55 = uptrend)
  if (snap.ema9 > snap.ema21 && snap.ema21 > snap.ema55) score += 15;
  else if (snap.ema9 < snap.ema21 && snap.ema21 < snap.ema55) score -= 15;

  // Bollinger position
  const bbRange = snap.bbUpper - snap.bbLower;
  if (bbRange > 0) {
    const bbPos = (snap.close - snap.bbLower) / bbRange;
    if (bbPos < 0.2) score += 12;
    else if (bbPos > 0.8) score -= 12;
  }

  // Recent momentum
  if (snap.priceChange5 > 0.01) score += 6;
  else if (snap.priceChange5 < -0.01) score -= 6;

  // Volume confirmation
  if (snap.volumeRatio > 1.5) {
    // amplifies the existing direction
    score += score > 0 ? 8 : score < 0 ? -8 : 0;
  }

  return score;
}

// nnProb: 0..1 from the neural net (P of next candle going up). Pass null to skip.
// confidenceThreshold: minimum |confidence-0.5|*2 for non-HOLD signal.
// atrMultiplier: stop = price ± ATR * mult; tp = price ± ATR * mult * 2 (RR 1:2)
function generate({ snapshot, nnProb, confidenceThreshold = 0.6, atrMultiplier = 1.5 }) {
  const heuristic = heuristicScore(snapshot);
  // Map heuristic [-100..+100] to a probability in [0..1]
  const heurProb = 0.5 + Math.tanh(heuristic / 60) * 0.5;

  // Blend NN and heuristic. If NN is missing (no model yet), use heuristic alone.
  const probability = nnProb != null ? nnProb * 0.6 + heurProb * 0.4 : heurProb;
  const confidence = Math.abs(probability - 0.5) * 2; // 0..1

  let direction = 'HOLD';
  if (probability > confidenceThreshold) direction = 'BUY';
  else if (probability < 1 - confidenceThreshold) direction = 'SELL';

  const price = snapshot.close;
  const atr = snapshot.atr14;
  let stop = null, tp = null, riskReward = null;
  if (direction === 'BUY') {
    stop = price - atr * atrMultiplier;
    tp = price + atr * atrMultiplier * 2;
    riskReward = (tp - price) / (price - stop);
  } else if (direction === 'SELL') {
    stop = price + atr * atrMultiplier;
    tp = price - atr * atrMultiplier * 2;
    riskReward = (price - tp) / (stop - price);
  }

  return {
    direction,
    probability: Math.round(probability * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    heuristic: Math.round(heuristic),
    nnProb: nnProb != null ? Math.round(nnProb * 1000) / 1000 : null,
    price,
    stop: stop != null ? Math.round(stop * 1e8) / 1e8 : null,
    tp: tp != null ? Math.round(tp * 1e8) / 1e8 : null,
    riskReward: riskReward != null ? Math.round(riskReward * 100) / 100 : null,
    atr,
  };
}

module.exports = { generate, heuristicScore };
