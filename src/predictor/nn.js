// Pure-JS feed-forward neural network: input → hidden (ReLU) → output (sigmoid).
// Trained with mini-batch SGD + binary cross-entropy. No native deps.
//
// This is intentionally small (12 → 16 → 1 by default) — fast to train on a few
// hundred candles and avoids the brittleness of a deeper net on noisy crypto data.

function randn() {
  // Box–Muller for Gaussian
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const sigmoid = x => 1 / (1 + Math.exp(-x));
const relu = x => x > 0 ? x : 0;
const reluD = x => x > 0 ? 1 : 0;

class NeuralNet {
  constructor({ inputSize, hiddenSize = 16, learningRate = 0.01, seed }) {
    if (seed !== undefined) {
      // Deterministic-ish seed for reproducible weights — simple LCG fed into Math.random override.
      // Skipped here for simplicity; using Math.random directly.
    }
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;
    this.learningRate = learningRate;

    // He init for ReLU layer
    const heScale = Math.sqrt(2 / inputSize);
    this.W1 = Array.from({ length: hiddenSize }, () =>
      Array.from({ length: inputSize }, () => randn() * heScale)
    );
    this.b1 = new Array(hiddenSize).fill(0);

    // Xavier for output
    const xavScale = Math.sqrt(1 / hiddenSize);
    this.W2 = Array.from({ length: hiddenSize }, () => randn() * xavScale);
    this.b2 = 0;
  }

  forward(x) {
    const z1 = new Array(this.hiddenSize);
    const a1 = new Array(this.hiddenSize);
    for (let j = 0; j < this.hiddenSize; j++) {
      let s = this.b1[j];
      const wj = this.W1[j];
      for (let i = 0; i < this.inputSize; i++) s += wj[i] * x[i];
      z1[j] = s;
      a1[j] = relu(s);
    }
    let z2 = this.b2;
    for (let j = 0; j < this.hiddenSize; j++) z2 += this.W2[j] * a1[j];
    const yhat = sigmoid(z2);
    return { yhat, a1, z1 };
  }

  predict(x) {
    return this.forward(x).yhat;
  }

  // Train one epoch over (X, y). Returns mean BCE loss.
  trainEpoch(X, y, batchSize = 16) {
    const n = X.length;
    const idx = Array.from({ length: n }, (_, i) => i);
    // Shuffle
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const lr = this.learningRate;
    let totalLoss = 0;

    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(n, start + batchSize);
      const bs = end - start;

      // Accumulate gradients across batch
      const dW1 = Array.from({ length: this.hiddenSize }, () => new Array(this.inputSize).fill(0));
      const db1 = new Array(this.hiddenSize).fill(0);
      const dW2 = new Array(this.hiddenSize).fill(0);
      let db2 = 0;

      for (let k = start; k < end; k++) {
        const x = X[idx[k]];
        const target = y[idx[k]];
        const { yhat, a1, z1 } = this.forward(x);

        // BCE loss (clamped for numerical stability)
        const eps = 1e-7;
        const ph = Math.min(1 - eps, Math.max(eps, yhat));
        totalLoss += -(target * Math.log(ph) + (1 - target) * Math.log(1 - ph));

        // Output layer gradient (sigmoid + BCE → dL/dz2 = yhat - target)
        const dz2 = yhat - target;
        for (let j = 0; j < this.hiddenSize; j++) dW2[j] += dz2 * a1[j];
        db2 += dz2;

        // Hidden layer
        for (let j = 0; j < this.hiddenSize; j++) {
          const da1 = this.W2[j] * dz2;
          const dz1 = da1 * reluD(z1[j]);
          db1[j] += dz1;
          const dwRow = dW1[j];
          for (let i = 0; i < this.inputSize; i++) dwRow[i] += dz1 * x[i];
        }
      }

      // Apply averaged gradient
      for (let j = 0; j < this.hiddenSize; j++) {
        for (let i = 0; i < this.inputSize; i++) {
          this.W1[j][i] -= lr * dW1[j][i] / bs;
        }
        this.b1[j] -= lr * db1[j] / bs;
        this.W2[j] -= lr * dW2[j] / bs;
      }
      this.b2 -= lr * db2 / bs;
    }
    return totalLoss / n;
  }

  // Trains for up to `iterations` epochs, stops early if loss <= errorThresh.
  train(X, y, { iterations = 200, errorThresh = 0.45, batchSize = 16, log } = {}) {
    let lastLoss = Infinity;
    let i;
    for (i = 0; i < iterations; i++) {
      lastLoss = this.trainEpoch(X, y, batchSize);
      if (log && (i % 25 === 0 || i === iterations - 1)) log(i, lastLoss);
      if (lastLoss <= errorThresh) { i++; break; }
    }
    return { iterations: i, loss: lastLoss };
  }

  toJSON() {
    return {
      inputSize: this.inputSize,
      hiddenSize: this.hiddenSize,
      learningRate: this.learningRate,
      W1: this.W1, b1: this.b1, W2: this.W2, b2: this.b2,
    };
  }

  static fromJSON(j) {
    const nn = new NeuralNet({
      inputSize: j.inputSize, hiddenSize: j.hiddenSize, learningRate: j.learningRate,
    });
    nn.W1 = j.W1; nn.b1 = j.b1; nn.W2 = j.W2; nn.b2 = j.b2;
    return nn;
  }
}

module.exports = { NeuralNet };
