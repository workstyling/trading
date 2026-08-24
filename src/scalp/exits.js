/**
 * ЧЕМ ЗАЩИЩАТЬ ПОЗИЦИЮ ПОСЛЕ ВХОДА.
 * ────────────────────────────────────────────────────────────────────────
 * Фиксированный стоп −3% при цели +1.38% требует 75% побед и измеренно
 * вредит. Но и без защиты позиция может уехать глубоко вниз.
 *
 * Идея: выходить не по проценту, а когда РАЗВАЛИВАЕТСЯ ПРИЧИНА ВХОДА.
 * Входим потому, что цена у дна диапазона, RSI вылез из перепроданности
 * и цена выше EMA9. Значит выход — когда цена теряет EMA9 или проваливает
 * дно, от которого отскакивала.
 *
 * Тестируем варианты выхода на одном и том же наборе входов и сравниваем
 * ожидание на сделку с учётом комиссий и глубину худшей просадки.
 *
 * Запуск: node src/scalp/exits.js [дней] [минОбъём]
 */
const fs = require('fs');
const path = require('path');

const DAYS = parseInt(process.argv[2], 10) || 7;
const MIN_VOL = parseFloat(process.argv[3]) || 500e3;
const TP = 1.38, FEE = 0.25;
const MAX_BARS = 288;            // 24 часа в 5m-барах — предел жизни сделки в тесте
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STABLE = new Set(['USDT','USDC','DAI','BUSD','TUSD','GUSD','USDP','FRAX','LUSD','CRVUSD',
  'PYUSD','EURC','FDUSD','USDS','USDM','SUSD','DOLA','RAI','EUR','GBP','CBETH','PAXG','WBTC']);

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function emaSeries(v, p) {
  const out = new Array(v.length).fill(null);
  if (v.length < p) return out;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = e;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) { e = v[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, H);
      if (r.status === 429) { await sleep(600 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(250); }
  }
  return null;
}
async function fetch5m(coin, days) {
  const out = [];
  let end = Date.now();
  for (let p = 0; p < Math.ceil(days * 24 * 12 / 300); p++) {
    const start = end - 300 * 300 * 1000;
    const d = await fetchJson(`${CB}/products/${coin}-USD/candles?granularity=300&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`);
    if (Array.isArray(d) && d.length) out.push(...d); else break;
    end = start;
    await sleep(110);
  }
  return out.filter(c => Array.isArray(c) && c[4] > 0)
    .map(c => ({ t: c[0], low: c[1], high: c[2], open: c[3], close: c[4], vol: c[5] }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Варианты защиты. Каждый получает состояние бара и решает: выйти или держать.
 * Возврат: null — держим, число — цена выхода.
 */
const EXITS = {
  'без защиты': () => null,

  'стоп −3%': (s) => s.low <= s.entry * 0.97 ? s.entry * 0.97 : null,
  'стоп −1.5%': (s) => s.low <= s.entry * 0.985 ? s.entry * 0.985 : null,

  // Дальние «катастрофические» стопы: не мешают обычной сделке дойти до цели,
  // но обрезают хвост, где позиция уезжает глубоко и надолго
  'стоп −5%': (s) => s.low <= s.entry * 0.95 ? s.entry * 0.95 : null,
  'стоп −6%': (s) => s.low <= s.entry * 0.94 ? s.entry * 0.94 : null,
  'стоп −8%': (s) => s.low <= s.entry * 0.92 ? s.entry * 0.92 : null,
  'стоп −10%': (s) => s.low <= s.entry * 0.90 ? s.entry * 0.90 : null,

  // Причина входа была «цена выше EMA9». Потеряли — причина исчезла.
  'закрытие ниже EMA9': (s) => s.e9 != null && s.close < s.e9 ? s.close : null,

  // То же, но выходим только когда мы В МИНУСЕ: прибыльную сделку не режем
  'ниже EMA9 и в минусе': (s) => s.e9 != null && s.close < s.e9 && s.close < s.entry ? s.close : null,

  // Два бара подряд под EMA9 — фильтр от одиночного прокола
  'два бара под EMA9': (s) => s.belowE9Streak >= 2 && s.close < s.entry ? s.close : null,

  // Провалили дно диапазона, от которого отскакивали
  'пробой дна входа': (s) => s.low < s.entryLow ? s.entryLow : null,

  // Комбинация: причина исчезла ИЛИ провалили дно
  'EMA9 в минусе + дно': (s) =>
    (s.e9 != null && s.close < s.e9 && s.close < s.entry) ? s.close
      : (s.low < s.entryLow ? s.entryLow : null),

  // Страховочный дальний стоп поверх сигнального выхода
  'два бара под EMA9 + стоп −4%': (s) =>
    s.low <= s.entry * 0.96 ? s.entry * 0.96
      : (s.belowE9Streak >= 2 && s.close < s.entry ? s.close : null),
};

function simulate(c, i, e9, exitFn, entryLow) {
  const entry = c[i].close;
  let belowE9Streak = 0;
  for (let j = i + 1; j <= Math.min(i + MAX_BARS, c.length - 1); j++) {
    // Цель проверяем первой: лимитка на продажу стоит и исполнится сама
    if (c[j].high >= entry * (1 + TP / 100)) {
      return { pnl: TP - FEE, bars: j - i, why: 'TP' };
    }
    belowE9Streak = (e9[j] != null && c[j].close < e9[j]) ? belowE9Streak + 1 : 0;
    const px = exitFn({
      entry, entryLow, close: c[j].close, low: c[j].low, high: c[j].high,
      e9: e9[j], belowE9Streak,
    });
    if (px != null) {
      return { pnl: (px / entry - 1) * 100 - FEE, bars: j - i, why: 'EXIT' };
    }
  }
  const last = Math.min(i + MAX_BARS, c.length - 1);
  return { pnl: (c[last].close / entry - 1) * 100 - FEE, bars: last - i, why: 'TIME' };
}

(async () => {
  const t0 = Date.now();
  console.log('Вселенная...');
  const products = await fetchJson(`${CB}/products`);
  const pairs = (products || []).filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map(p => p.base_currency).filter(s => !STABLE.has(s));
  const uni = [];
  for (let i = 0; i < pairs.length; i += 25) {
    const st = await Promise.all(pairs.slice(i, i + 25).map(async c => {
      const s = await fetchJson(`${CB}/products/${c}-USD/stats`, 1);
      if (!s) return null;
      const vol = (parseFloat(s.volume) || 0) * (parseFloat(s.last) || 0);
      return vol >= MIN_VOL ? { coin: c, vol } : null;
    }));
    uni.push(...st.filter(Boolean));
    await sleep(150);
  }
  uni.sort((a, b) => b.vol - a.vol);
  const coins = uni.slice(0, 110).map(x => x.coin);
  console.log(`${coins.length} монет, ${DAYS} дней, цель +${TP}%, комиссия круга ${FEE}%\n`);

  // BTC для фильтра режима — вход берём только при BTC выше EMA20
  const btc = await fetch5m('BTC', DAYS);
  const btcCloses = btc.map(x => x.close);
  const btcE = emaSeries(btcCloses, 240);
  const btcOk = new Map();
  for (let i = 0; i < btc.length; i++) btcOk.set(btc[i].t, btcE[i] != null && btcCloses[i] > btcE[i]);

  const results = {};
  for (const k of Object.keys(EXITS)) results[k] = [];
  let trades = 0;

  for (let ci = 0; ci < coins.length; ci++) {
    const c = await fetch5m(coins[ci], DAYS);
    if (c.length < 600) { process.stdout.write('.'); continue; }
    const closes = c.map(x => x.close);
    const rsi = rsiSeries(closes, 14);
    const e9 = emaSeries(closes, 9);
    let openSince = null;
    for (let i = 60; i < c.length - MAX_BARS; i++) {
      // гейт входа — тот же, что в проде
      const px = closes[i];
      const win = c.slice(i - 48, i + 1);
      const lo = Math.min(...win.map(x => x.low)), hi = Math.max(...win.map(x => x.high));
      const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;
      const rWin = rsi.slice(i - 12, i + 1).filter(v => v != null);
      const rMin = rWin.length ? Math.min(...rWin) : null;
      const gate = rangePos < 0.25 && rMin != null && rMin < 30 && rsi[i] > rMin + 3
        && e9[i] != null && px > e9[i] && btcOk.get(c[i].t);
      if (!gate) { openSince = null; continue; }
      if (openSince !== null && i - openSince < 6) continue;   // не дублируем вход
      openSince = i;
      trades++;
      for (const [name, fn] of Object.entries(EXITS)) {
        results[name].push(simulate(c, i, e9, fn, lo));
      }
    }
    if (ci % 15 === 0) process.stdout.write(`\n[${ci}/${coins.length}] сделок ${trades} `); else process.stdout.write('•');
  }

  console.log(`\n\nВходов: ${trades} · время ${Math.round((Date.now() - t0) / 1000)}с\n`);
  if (trades < 100) { console.log('Мало входов для выводов.'); return; }

  const rows = Object.entries(results).map(([name, arr]) => {
    const n = arr.length;
    const exp = arr.reduce((a, x) => a + x.pnl, 0) / n;
    const wins = arr.filter(x => x.pnl > 0).length;
    const losses = arr.filter(x => x.pnl <= 0);
    const worst = Math.min(...arr.map(x => x.pnl));
    const avgLoss = losses.length ? losses.reduce((a, x) => a + x.pnl, 0) / losses.length : 0;
    const sorted = [...arr].map(x => x.pnl).sort((a, b) => a - b);
    const p05 = sorted[Math.floor(n * 0.05)];
    const avgBars = arr.reduce((a, x) => a + x.bars, 0) / n;
    const byTP = arr.filter(x => x.why === 'TP').length;
    return { name, n, exp, win: Math.round(wins / n * 100), worst, avgLoss, p05, avgBars, tpShare: Math.round(byTP / n * 100) };
  });

  console.log('═'.repeat(104));
  console.log('  ЧЕМ ЗАЩИЩАТЬ ПОЗИЦИЮ — сравнение на одних и тех же входах');
  console.log('═'.repeat(104));
  console.log('  ВАРИАНТ ВЫХОДА                ОЖИДАНИЕ   WIN%   ДОШЛИ ДО ЦЕЛИ   СРЕДНИЙ УБЫТОК   ХУДШИЕ 5%   САМЫЙ ХУДШИЙ   ЧАСОВ');
  console.log('  ' + '─'.repeat(100));
  rows.sort((a, b) => b.exp - a.exp).forEach(r => {
    console.log(
      '  ' + r.name.padEnd(30) +
      ((r.exp >= 0 ? '+' : '') + r.exp.toFixed(3) + '%').padStart(9) +
      (r.win + '%').padStart(7) +
      (r.tpShare + '%').padStart(16) +
      (r.avgLoss.toFixed(2) + '%').padStart(17) +
      (r.p05.toFixed(1) + '%').padStart(12) +
      (r.worst.toFixed(1) + '%').padStart(15) +
      (r.avgBars / 12).toFixed(1).padStart(8)
    );
  });

  // Устойчивость лучших по трём отрезкам
  console.log('\n' + '═'.repeat(104));
  console.log('  УСТОЙЧИВОСТЬ ПО ТРЁМ ОТРЕЗКАМ ВРЕМЕНИ (ожидание на сделку)');
  console.log('═'.repeat(104));
  const idx = results['без защиты'].map((_, k) => k);
  const third = Math.floor(idx.length / 3);
  const segs = [[0, third], [third, third * 2], [third * 2, idx.length]];
  const top = rows.slice(0, 5).map(r => r.name);
  console.log('  ВАРИАНТ                        отр.1      отр.2      отр.3     в плюс');
  console.log('  ' + '─'.repeat(70));
  for (const name of top) {
    const arr = results[name];
    const vals = segs.map(([a, b]) => {
      const sub = arr.slice(a, b);
      return sub.length ? sub.reduce((x, y) => x + y.pnl, 0) / sub.length : null;
    });
    const good = vals.filter(v => v != null && v > 0).length;
    console.log('  ' + name.padEnd(30) + vals.map(v => ((v >= 0 ? '+' : '') + v.toFixed(3) + '%').padStart(10)).join(' ') + `    ${good}/3 ` + (good === 3 ? '✅' : good === 0 ? '❌' : '⚠️'));
  }

  fs.writeFileSync(path.join(__dirname, '..', '..', 'scalp-exits.json'), JSON.stringify({ rows, trades, at: Date.now() }, null, 2));
  console.log('\nРезультат: scalp-exits.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
