// Top-level predictor orchestration:
// - per-symbol cache of (candles, model, latest signal)
// - on-demand training + walk-forward backtest
// - live signal generation against the latest fresh candles
//
// Designed to be called from server.js HTTP routes and a periodic refresher.

const { fetchHistorical } = require('./collector');
const { computeAll, snapshotAt } = require('./indicators');
const { vectorAt, latestVector } = require('./features');
const { NeuralNet } = require('./nn');
const { generate } = require('./signal');
const backtest = require('./backtest');
const storage = require('./storage');

const GRANULARITY = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400,
};

// In-memory cache keyed by `${symbol}_${timeframe}`
const cache = new Map();

function key(symbol, tf) { return `${symbol}_${tf}`; }

async function ensureData(symbol, tf, candleCount) {
  const gran = GRANULARITY[tf];
  if (!gran) throw new Error(`Unsupported timeframe: ${tf}`);
  const k = key(symbol, tf);
  let entry = cache.get(k);
  if (!entry) {
    // Try disk first
    const disk = storage.loadCandles(symbol, tf);
    entry = { symbol, tf, gran, candles: disk, model: null, latestSignal: null, lastFetched: 0, training: false };
    const diskModel = storage.loadModel(symbol, tf);
    if (diskModel) entry.model = NeuralNet.fromJSON(diskModel);
    cache.set(k, entry);
  }

  // Refresh if older than 1 candle
  const stale = Date.now() - entry.lastFetched > gran * 1000;
  if (entry.candles.length < candleCount || stale) {
    const fresh = await fetchHistorical(symbol, gran, candleCount);
    entry.candles = storage.mergeCandles(symbol, tf, fresh).slice(-Math.max(candleCount, fresh.length));
    entry.lastFetched = Date.now();
  }
  return entry;
}

async function trainSymbol(symbol, tf, opts = {}) {
  const { candleCount = 500, iterations = 200, hiddenSize = 16, learningRate = 0.01 } = opts;
  const entry = await ensureData(symbol, tf, candleCount);
  if (entry.candles.length < 100) throw new Error(`Not enough candles for ${symbol} ${tf}: ${entry.candles.length}`);

  entry.training = true;
  try {
    const { buildDataset } = require('./features');
    const { X, y } = buildDataset(entry.candles);
    if (X.length < 30) throw new Error('Not enough samples after indicator warm-up');

    const nn = new NeuralNet({ inputSize: X[0].length, hiddenSize, learningRate });
    const result = nn.train(X, y, { iterations, errorThresh: 0.4 });
    entry.model = nn;
    storage.saveModel(symbol, tf, nn.toJSON());
    entry.lastTrained = Date.now();
    entry.lastTrainResult = result;
    return { symbol, tf, samples: X.length, ...result };
  } finally {
    entry.training = false;
  }
}

async function predictSymbol(symbol, tf, opts = {}) {
  const { candleCount = 200, confidenceThreshold = 0.6, atrMultiplier = 1.5 } = opts;
  const entry = await ensureData(symbol, tf, candleCount);
  const latest = latestVector(entry.candles);
  if (!latest) return { symbol, tf, error: 'Not enough data for indicators' };

  let nnProb = null;
  if (entry.model) nnProb = entry.model.predict(latest.vector);

  const signal = generate({
    snapshot: latest.snapshot, nnProb,
    confidenceThreshold, atrMultiplier,
  });

  const result = {
    symbol, tf,
    timestamp: entry.candles[latest.index].t,
    candleCount: entry.candles.length,
    hasModel: !!entry.model,
    lastTrained: entry.lastTrained || null,
    indicators: latest.snapshot,
    signal,
  };
  entry.latestSignal = result;

  // Persist non-HOLD signals for history
  if (signal.direction !== 'HOLD') {
    storage.saveSignal({
      ts: result.timestamp,
      savedAt: Date.now(),
      symbol, tf,
      direction: signal.direction,
      probability: signal.probability,
      confidence: signal.confidence,
      price: signal.price,
      stop: signal.stop,
      tp: signal.tp,
      riskReward: signal.riskReward,
    });
  }

  return result;
}

async function backtestSymbol(symbol, tf, opts = {}) {
  const { candleCount = 500 } = opts;
  const entry = await ensureData(symbol, tf, candleCount);
  return backtest.run(entry.candles, opts);
}

// Scan many coins in parallel to highlight which ones are "promising right now".
// Returns a ranked list — strong-confidence BUY signals first, then by confidence.
async function scanWatchlist(watchlist, tf, opts = {}) {
  const out = [];
  for (const symbol of watchlist) {
    try {
      const r = await predictSymbol(symbol, tf, opts);
      if (!r.error) out.push(r);
    } catch (e) {
      out.push({ symbol, tf, error: e.message });
    }
  }
  return out
    .filter(r => !r.error)
    .sort((a, b) => {
      const dirRank = d => d === 'BUY' ? 0 : d === 'SELL' ? 1 : 2;
      const ra = dirRank(a.signal.direction), rb = dirRank(b.signal.direction);
      if (ra !== rb) return ra - rb;
      return b.signal.confidence - a.signal.confidence;
    });
}

function getCacheState() {
  const out = [];
  for (const [k, v] of cache) {
    out.push({
      key: k,
      symbol: v.symbol,
      tf: v.tf,
      candles: v.candles.length,
      hasModel: !!v.model,
      lastTrained: v.lastTrained || null,
      lastFetched: v.lastFetched,
      training: v.training,
      latestSignal: v.latestSignal?.signal || null,
    });
  }
  return out;
}

module.exports = {
  ensureData, trainSymbol, predictSymbol, backtestSymbol, scanWatchlist,
  getCacheState, GRANULARITY, storage,
};
