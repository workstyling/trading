/**
 * ИСТОРИЧЕСКИЙ БЭКТЕСТ сигналов разворота на реальных данных Coinbase.
 *
 * Вопрос, на который отвечаем: какие из сигналов (oversold RSI, volume spike,
 * bullish divergence, higher low, breakout) реально дают статистическое
 * преимущество, а какие только красиво выглядят.
 *
 * Метод:
 *   • качаем часовые свечи за N дней постранично, агрегируем в 4H
 *   • идём по барам вперёд; в каждом баре i видим ТОЛЬКО данные [0..i]
 *     (детекторы подтверждают свинги 2 барами, поэтому заглядывания вперёд нет)
 *   • берём бары, где монета в просадке (30d ≤ порог) — это «пул кандидатов»
 *   • для каждого считаем сигналы и меряем будущее: +6ч, +24ч, +3д, +7д
 *     и барьерный тест (что раньше: +5% или −3%) — как реальная сделка
 *   • сравниваем каждый сигнал с БАЗОЙ (все бары пула) → lift в п.п.
 *
 * Запуск: node src/reversal/backtest.js [дней] [минОбъём]
 */
const rev = require('./index');
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 150;
const MIN_VOL = parseFloat(process.argv[3]) || 200e3;
const DROP_POOL = -25;        // порог просадки для попадания в пул кандидатов
const MIN_GAP_BARS = 12;      // 2 суток между сигналами одной монеты — против дублей
const BARS = { '6h': 2, '24h': 6, '3d': 18, '7d': 42 };
const TP = 0.05, SL = 0.03;   // барьерный тест: +5% раньше −3%?
const BARRIER_BARS = 18;      // горизонт барьера — 3 дня

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };

async function fetchPaged(coin, days) {
  const out = [];
  let end = Date.now();
  const pages = Math.ceil(days * 24 / 300);
  for (let p = 0; p < pages; p++) {
    const start = end - 300 * 3600 * 1000;
    const url = `${CB}/products/${coin}-USD/candles?granularity=3600&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    let raw = null;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url, H);
        if (r.status === 429) { await sleep(600 * (a + 1)); continue; }
        if (!r.ok) break;
        raw = await r.json();
        break;
      } catch { await sleep(300); }
    }
    if (Array.isArray(raw) && raw.length) out.push(...raw); else break;
    end = start;
    await sleep(120);
  }
  return rev.normalizeCandles(out);
}

/** Метрики будущего от бара i */
function forward(c4, i) {
  const entry = c4[i].close;
  const out = {};
  for (const [k, n] of Object.entries(BARS)) {
    const j = i + n;
    out[k] = j < c4.length ? (c4[j].close / entry - 1) * 100 : null;
  }
  // барьерный тест: что случилось раньше — TP или SL
  let barrier = null, mfe = 0, mae = 0;
  for (let j = i + 1; j <= Math.min(i + BARRIER_BARS, c4.length - 1); j++) {
    const up = (c4[j].high / entry - 1), dn = (c4[j].low / entry - 1);
    if (up > mfe) mfe = up;
    if (dn < mae) mae = dn;
    if (barrier === null) {
      if (dn <= -SL) barrier = 0;        // стоп раньше (консервативно: при обоих в одной свече — стоп)
      else if (up >= TP) barrier = 1;
    }
  }
  out.barrier = barrier;                 // 1 = TP раньше, 0 = SL раньше, null = ни то, ни то
  out.mfe = mfe * 100;
  out.mae = mae * 100;
  return out;
}

function agg(rows, key) {
  const vals = rows.map(r => r.fwd[key]).filter(v => v != null);
  if (!vals.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return {
    n: vals.length,
    winPct: Math.round(vals.filter(v => v > 0).length / vals.length * 100),
    avg: Math.round(mean * 100) / 100,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
  };
}

function barrierStats(rows) {
  const resolved = rows.filter(r => r.fwd.barrier != null);
  const wins = resolved.filter(r => r.fwd.barrier === 1).length;
  const losses = resolved.length - wins;
  const pf = losses ? (wins * TP) / (losses * SL) : null;
  return {
    n: resolved.length,
    unresolved: rows.length - resolved.length,
    winRate: resolved.length ? Math.round(wins / resolved.length * 100) : null,
    profitFactor: pf != null ? Math.round(pf * 100) / 100 : null,
    avgMfe: Math.round(rows.reduce((a, r) => a + r.fwd.mfe, 0) / rows.length * 100) / 100,
    avgMae: Math.round(rows.reduce((a, r) => a + r.fwd.mae, 0) / rows.length * 100) / 100,
  };
}

(async () => {
  const t0 = Date.now();
  const diag = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'reversal-diagnose.json'), 'utf8'));
  const universe = diag.all
    .filter(c => c.mcap >= 20e6 && c.mcap <= 5e9 && !c.collision && c.vol24 >= MIN_VOL)
    .map(c => c.coin);
  console.log(`Вселенная: ${universe.length} монет (mcap $20M–$5B, vol24 ≥ $${(MIN_VOL / 1e3).toFixed(0)}K)`);
  console.log(`История: ${DAYS} дней часовых свечей → 4H бары\n`);

  const samples = [];
  let coinsOk = 0, barsScanned = 0;

  for (let ci = 0; ci < universe.length; ci++) {
    const coin = universe[ci];
    let hourly;
    try { hourly = await fetchPaged(coin, DAYS); } catch { continue; }
    if (hourly.length < 24 * 60) { process.stdout.write('.'); continue; }
    const c4 = rev.aggregateTo4H(hourly);
    if (c4.length < 260) { process.stdout.write('.'); continue; }
    coinsOk++;
    const closes = c4.map(c => c.close);
    const rsi = rev.rsiSeries(closes, 14);
    const bars30d = 180; // 30 дней в 4H-барах
    let lastSignalBar = -999;

    for (let i = bars30d; i < c4.length - BARS['7d']; i++) {
      const pct30d = (closes[i] / closes[i - bars30d] - 1) * 100;
      if (pct30d > DROP_POOL) continue;             // не в просадке — не наш случай
      barsScanned++;
      if (i - lastSignalBar < MIN_GAP_BARS) continue;
      lastSignalBar = i;

      const hist = c4.slice(0, i + 1);              // только прошлое
      const rsiHist = rsi.slice(0, i + 1);
      const vols = hist.slice(-30).map(c => c.vol);
      const recentVol = vols.slice(-6).reduce((a, b) => a + b, 0) / 6;
      const baseVol = vols.slice(0, -6).reduce((a, b) => a + b, 0) / Math.max(1, vols.length - 6);
      const volSpike = baseVol > 0 ? recentVol / baseVol : 0;
      const rsiNow = rsi[i];
      const rsiWin = rsi.slice(Math.max(0, i - 42), i + 1).filter(v => v != null);
      const rsiMin = rsiWin.length ? Math.min(...rsiWin) : null;
      const e20 = rev.ema(closes.slice(0, i + 1), 20);

      const div = rev.detectDivergence(hist, rsiHist);
      const hl = rev.detectHigherLow(hist);
      const bo = rev.detectBreakout(hist);
      const cap = rev.detectCapitulation(hist);

      const m = {
        coin, pct30d, pct60d: null,
        vol24: 1e6, volToMcap: 0.01, mcap: 1e8,   // нейтрально: ликвидность уже отфильтрована вселенной
        rsi4h: rsiNow, rsiMin7d: rsiMin,
        volSpike, aboveEma20_4h: e20 != null && closes[i] > e20,
        divergence: div, higherLow: hl, breakout: bo, capitulation: cap,
        btc: null,
      };
      const sc = rev.scoreCoin(m);

      samples.push({
        coin, t: c4[i].t, i,
        pct30d: Math.round(pct30d * 10) / 10,
        rsi: rsiNow != null ? Math.round(rsiNow * 10) / 10 : null,
        rsiRecovering: rsiMin != null && rsiNow != null && rsiMin < 30 && rsiNow > rsiMin + 4,
        volSpike: Math.round(volSpike * 100) / 100,
        div: !!div.found, hl: !!hl.found, bo: !!bo.found, cap: !!cap.found,
        aboveEma: m.aboveEma20_4h,
        score: sc.score, conf: sc.confirmScore, os: sc.oversoldScore,
        fwd: forward(c4, i),
      });
    }
    if (ci % 10 === 0) process.stdout.write(`\n[${ci}/${universe.length}] ${coin} — сэмплов: ${samples.length} `);
    else process.stdout.write('•');
  }

  console.log(`\n\nМонет с достаточной историей: ${coinsOk} · баров в просадке: ${barsScanned} · сэмплов (после дедупа): ${samples.length}`);
  console.log(`Время: ${Math.round((Date.now() - t0) / 1000)}с\n`);

  if (samples.length < 30) { console.log('Слишком мало сэмплов для выводов.'); return; }

  const base = samples;
  const baseBar = barrierStats(base);
  const line = '─'.repeat(96);

  console.log('═'.repeat(96));
  console.log(`  БАЗА: все бары, где монета в просадке 30d ≤ ${DROP_POOL}%  (n=${base.length})`);
  console.log('═'.repeat(96));
  console.log(`  Барьер (+${TP * 100}% раньше −${SL * 100}% за 3д): win ${baseBar.winRate}% · PF ${baseBar.profitFactor} · разрешилось ${baseBar.n}, зависло ${baseBar.unresolved}`);
  for (const k of Object.keys(BARS)) {
    const a = agg(base, k);
    console.log(`  ${k.padEnd(4)}: выше входа ${String(a.winPct).padStart(3)}% · средн ${(a.avg >= 0 ? '+' : '') + a.avg}% · медиана ${(a.median >= 0 ? '+' : '') + a.median}%`);
  }
  console.log(`  Средний MFE +${baseBar.avgMfe}% / MAE ${baseBar.avgMae}%`);

  // ── Каждый сигнал против базы ──
  const signals = {
    'RSI < 30': s => s.rsi != null && s.rsi < 30,
    'RSI < 35': s => s.rsi != null && s.rsi < 35,
    'RSI выходит из ямы': s => s.rsiRecovering,
    'Volume spike ≥1.5x': s => s.volSpike >= 1.5,
    'Volume spike ≥2x': s => s.volSpike >= 2,
    'Volume spike ≥3x': s => s.volSpike >= 3,
    'Капитуляционная свеча': s => s.cap,
    'Bullish divergence': s => s.div,
    'Higher Low': s => s.hl,
    'Breakout': s => s.bo,
    'Выше EMA20 4H': s => s.aboveEma,
    'DIV + HL': s => s.div && s.hl,
    'HL + Breakout': s => s.hl && s.bo,
    'DIV + volume ≥2x': s => s.div && s.volSpike >= 2,
    'HL + выше EMA20': s => s.hl && s.aboveEma,
    'DIV + HL + BO (полный)': s => s.div && s.hl && s.bo,
  };

  console.log('\n' + '═'.repeat(96));
  console.log('  ОТДЕЛЬНЫЕ СИГНАЛЫ — барьерный тест (+5% раньше −3%, горизонт 3д) и доходности');
  console.log('═'.repeat(96));
  console.log('  СИГНАЛ                       N     WIN%   LIFT    PF     24h срд   3d срд    7d срд   MFE/MAE');
  console.log('  ' + line);
  const rowsOut = [];
  for (const [name, fn] of Object.entries(signals)) {
    const sub = base.filter(fn);
    if (sub.length < 20) { console.log(`  ${name.padEnd(26)} ${String(sub.length).padStart(4)}   — мало данных`); continue; }
    const b = barrierStats(sub);
    const a24 = agg(sub, '24h'), a3 = agg(sub, '3d'), a7 = agg(sub, '7d');
    const lift = b.winRate - baseBar.winRate;
    rowsOut.push({ name, n: sub.length, win: b.winRate, lift, pf: b.profitFactor, a24: a24.avg, a3: a3.avg, a7: a7.avg });
    console.log(`  ${name.padEnd(26)} ${String(sub.length).padStart(4)}   ${String(b.winRate).padStart(3)}%  ${(lift >= 0 ? '+' : '') + lift}пп`.padEnd(58) +
      `${String(b.profitFactor).padStart(5)}  ${(a24.avg >= 0 ? '+' : '') + a24.avg}%`.padStart(14) +
      `   ${(a3.avg >= 0 ? '+' : '') + a3.avg}%   ${(a7.avg >= 0 ? '+' : '') + a7.avg}%   +${b.avgMfe}/${b.avgMae}`);
  }

  console.log('\n  Отсортировано по lift (насколько сигнал лучше базы):');
  rowsOut.sort((a, b) => b.lift - a.lift).forEach(r =>
    console.log(`    ${(r.lift >= 0 ? '+' : '') + r.lift}пп`.padEnd(10) + `${r.name}  (n=${r.n}, win ${r.win}%, PF ${r.pf})`));

  // ── Монотонность композитного скора ──
  console.log('\n' + '═'.repeat(96));
  console.log('  КОМПОЗИТНЫЙ SCORE — работает ли он монотонно?');
  console.log('═'.repeat(96));
  const buckets = [[0, 35], [35, 45], [45, 55], [55, 65], [65, 75], [75, 101]];
  console.log('  SCORE       N     WIN%   LIFT     PF     24h      3d       7d');
  console.log('  ' + line);
  for (const [lo, hi] of buckets) {
    const sub = base.filter(s => s.score >= lo && s.score < hi);
    if (sub.length < 15) { console.log(`  ${(lo + '–' + hi).padEnd(10)} ${String(sub.length).padStart(4)}   — мало данных`); continue; }
    const b = barrierStats(sub);
    const a24 = agg(sub, '24h'), a3 = agg(sub, '3d'), a7 = agg(sub, '7d');
    console.log(`  ${(lo + '–' + hi).padEnd(10)} ${String(sub.length).padStart(4)}   ${String(b.winRate).padStart(3)}%  ${((b.winRate - baseBar.winRate) >= 0 ? '+' : '') + (b.winRate - baseBar.winRate)}пп`.padEnd(40) +
      `${String(b.profitFactor).padStart(5)}   ${(a24.avg >= 0 ? '+' : '') + a24.avg}%   ${(a3.avg >= 0 ? '+' : '') + a3.avg}%   ${(a7.avg >= 0 ? '+' : '') + a7.avg}%`);
  }

  // ── Confirmation score отдельно ──
  console.log('\n  Отдельно CONFIRMATION-часть (подтверждение разворота, макс 55):');
  for (const [lo, hi] of [[0, 10], [10, 20], [20, 30], [30, 56]]) {
    const sub = base.filter(s => s.conf >= lo && s.conf < hi);
    if (sub.length < 15) continue;
    const b = barrierStats(sub);
    const a3 = agg(sub, '3d');
    console.log(`    conf ${(lo + '–' + hi).padEnd(8)} n=${String(sub.length).padStart(4)}  win ${String(b.winRate).padStart(3)}%  (${((b.winRate - baseBar.winRate) >= 0 ? '+' : '') + (b.winRate - baseBar.winRate)}пп)  PF ${b.profitFactor}  3d ${(a3.avg >= 0 ? '+' : '') + a3.avg}%`);
  }

  console.log('\n  Отдельно OVERSOLD-часть (насколько продавили, макс 40):');
  for (const [lo, hi] of [[0, 15], [15, 22], [22, 28], [28, 41]]) {
    const sub = base.filter(s => s.os >= lo && s.os < hi);
    if (sub.length < 15) continue;
    const b = barrierStats(sub);
    const a3 = agg(sub, '3d');
    console.log(`    os   ${(lo + '–' + hi).padEnd(8)} n=${String(sub.length).padStart(4)}  win ${String(b.winRate).padStart(3)}%  (${((b.winRate - baseBar.winRate) >= 0 ? '+' : '') + (b.winRate - baseBar.winRate)}пп)  PF ${b.profitFactor}  3d ${(a3.avg >= 0 ? '+' : '') + a3.avg}%`);
  }

  fs.writeFileSync(path.join(__dirname, '..', '..', 'reversal-backtest.json'),
    JSON.stringify({ samples, base: baseBar, at: Date.now(), cfg: { DAYS, MIN_VOL, DROP_POOL, TP, SL } }));
  console.log('\nСырые сэмплы: reversal-backtest.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
