// JSON-file storage for candles, signals, and trained model weights.
// Keyed by symbol+granularity so each pair has its own dataset.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'predictor');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const MODELS_DIR = path.join(DATA_DIR, 'models');
const CANDLES_DIR = path.join(DATA_DIR, 'candles');

function ensureDirs() {
  for (const d of [DATA_DIR, MODELS_DIR, CANDLES_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

function safeKey(symbol, granularity) {
  return `${symbol.replace(/[^A-Z0-9]/gi, '')}_${granularity}`;
}

function candleFile(symbol, granularity) {
  return path.join(CANDLES_DIR, `${safeKey(symbol, granularity)}.json`);
}
function modelFile(symbol, granularity) {
  return path.join(MODELS_DIR, `${safeKey(symbol, granularity)}.json`);
}

function loadCandles(symbol, granularity) {
  try {
    const f = candleFile(symbol, granularity);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error('[predictor:storage] loadCandles error', e.message);
  }
  return [];
}

function saveCandles(symbol, granularity, candles) {
  const f = candleFile(symbol, granularity);
  fs.writeFileSync(f, JSON.stringify(candles));
}

// Merge new candles in by timestamp, keeping order ascending.
function mergeCandles(symbol, granularity, incoming) {
  const existing = loadCandles(symbol, granularity);
  const map = new Map();
  for (const c of existing) map.set(c.t, c);
  for (const c of incoming) map.set(c.t, c);
  const merged = Array.from(map.values()).sort((a, b) => a.t - b.t);
  saveCandles(symbol, granularity, merged);
  return merged;
}

function loadModel(symbol, granularity) {
  try {
    const f = modelFile(symbol, granularity);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error('[predictor:storage] loadModel error', e.message);
  }
  return null;
}

function saveModel(symbol, granularity, model) {
  const f = modelFile(symbol, granularity);
  fs.writeFileSync(f, JSON.stringify({ ...model, savedAt: Date.now() }));
}

function loadSignals() {
  try {
    if (fs.existsSync(SIGNALS_FILE)) return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveSignal(signal) {
  const all = loadSignals();
  all.unshift(signal);
  // Keep last 500 signals
  if (all.length > 500) all.length = 500;
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(all, null, 2));
}

module.exports = {
  loadCandles, saveCandles, mergeCandles,
  loadModel, saveModel,
  loadSignals, saveSignal,
};
