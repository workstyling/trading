// Walk-forward backtest: train on the first 70% of candles, evaluate on the last 30%.
// At each test step we generate a signal using the same code path as live inference,
// then "execute" the trade at the next candle's open with SL/TP exits at the close.
// Simplified — no slippage modeling beyond the configured fee.

const { computeAll, snapshotAt } = require('./indicators');
const { vectorAt, buildDataset } = require('./features');
const { NeuralNet } = require('./nn');
const { generate } = require('./signal');

function run(candles, opts = {}) {
  const {
    trainPct = 0.7,
    confidenceThreshold = 0.6,
    atrMultiplier = 1.5,
    feePct = 0.0006, // 0.06% — Coinbase taker
    iterations = 150,
    hiddenSize = 16,
    learningRate = 0.01,
  } = opts;

  if (candles.length < 100) return { error: 'Need at least 100 candles' };

  const split = Math.floor(candles.length * trainPct);
  const trainCandles = candles.slice(0, split);
  const testCandles = candles.slice(split);

  // Train on first 70%
  const { X, y } = buildDataset(trainCandles);
  if (X.length < 30) return { error: 'Not enough training samples after indicator warm-up' };
  const nn = new NeuralNet({ inputSize: X[0].length, hiddenSize, learningRate });
  const trainResult = nn.train(X, y, { iterations, errorThresh: 0.4 });

  // Pre-compute indicators across the full series so live inference at index i
  // sees the same look-back as production.
  const ind = computeAll(candles);

  const trades = [];
  let equity = 1.0;
  let peakEquity = 1.0;
  let maxDD = 0;

  // Iterate over test indexes, using next candle's open as fill price.
  for (let i = split; i < candles.length - 1; i++) {
    const v = vectorAt(ind, i);
    if (!v) continue;
    const snap = snapshotAt(ind, i);
    if (isNaN(snap.atr14)) continue;
    const nnProb = nn.predict(v);
    const sig = generate({ snapshot: snap, nnProb, confidenceThreshold, atrMultiplier });
    if (sig.direction === 'HOLD') continue;

    const entry = candles[i + 1].open;
    let exit = null;
    let exitReason = 'eod';
    // Walk forward looking for SL/TP hit; cap at 24 candles to avoid trades dragging forever
    const maxBars = 24;
    for (let j = i + 1; j < Math.min(candles.length, i + 1 + maxBars); j++) {
      const c = candles[j];
      if (sig.direction === 'BUY') {
        if (c.low <= sig.stop) { exit = sig.stop; exitReason = 'sl'; break; }
        if (c.high >= sig.tp) { exit = sig.tp; exitReason = 'tp'; break; }
      } else {
        if (c.high >= sig.stop) { exit = sig.stop; exitReason = 'sl'; break; }
        if (c.low <= sig.tp) { exit = sig.tp; exitReason = 'tp'; break; }
      }
    }
    if (exit == null) {
      const last = candles[Math.min(candles.length - 1, i + maxBars)];
      exit = last.close;
    }

    let pnlPct;
    if (sig.direction === 'BUY') pnlPct = (exit - entry) / entry;
    else pnlPct = (entry - exit) / entry;
    pnlPct -= feePct * 2; // entry + exit
    equity *= (1 + pnlPct);
    peakEquity = Math.max(peakEquity, equity);
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDD) maxDD = dd;

    trades.push({
      idx: i, direction: sig.direction, entry, exit, exitReason,
      pnlPct: Math.round(pnlPct * 10000) / 100, // %
      confidence: sig.confidence,
    });
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct < 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length : 0;
  const profitFactor = losses.length
    ? wins.reduce((a, b) => a + b.pnlPct, 0) / Math.abs(losses.reduce((a, b) => a + b.pnlPct, 0) || 1)
    : (wins.length ? Infinity : 0);
  const totalReturn = (equity - 1) * 100;

  // Sharpe-ish: mean / std of trade returns (per-trade, not annualized)
  let mean = 0, varSum = 0;
  for (const t of trades) mean += t.pnlPct;
  mean = trades.length ? mean / trades.length : 0;
  for (const t of trades) varSum += (t.pnlPct - mean) ** 2;
  const std = trades.length ? Math.sqrt(varSum / trades.length) : 0;
  const sharpe = std > 0 ? mean / std : 0;

  return {
    trainSamples: X.length,
    testCandles: testCandles.length,
    finalLoss: Math.round(trainResult.loss * 1000) / 1000,
    iterations: trainResult.iterations,
    totalTrades: trades.length,
    winRate: Math.round(winRate * 1000) / 10, // %
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxDrawdown: Math.round(maxDD * 1000) / 10,
    sharpe: Math.round(sharpe * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    trades: trades.slice(-30), // last 30 for inspection
    nnModel: nn.toJSON(),
  };
}

module.exports = { run };
