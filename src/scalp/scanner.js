/**
 * MARKET-WIDE SCALP SCANNER.
 *
 * It calculates structural candidates across liquid USD pairs. Historical
 * performance is evaluated separately by validate-gate.js.
 */

const scalp = require('./index');

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STABLE = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'GUSD', 'USDP', 'FRAX', 'LUSD',
  'CRVUSD', 'PYUSD', 'EURC', 'FDUSD', 'USDS', 'USDM', 'SUSD', 'DOLA', 'RAI', 'EUR', 'GBP',
  'CBETH', 'PAXG', 'WBTC']);

/** Режим рынка: цена BTC против EMA20 на часовых свечах */
async function fetchBtcRegime() {
  try {
    const r = await fetch(`${CB}/products/BTC-USD/candles?granularity=3600`, H);
    if (!r.ok) return null;
    const raw = await r.json();
    if (!Array.isArray(raw) || raw.length < 30) return null;
    const c = raw.filter(x => Array.isArray(x) && x[4] > 0).sort((a, b) => a[0] - b[0]);
    const closes = c.map(x => x[4]);
    const e = scalp.ema(closes, 20);
    const px = closes[closes.length - 1];
    const prev = closes[closes.length - 2];

    // BTC 7-day return is retained as a defensive structural condition, not a standalone profitability proof.
    let ret7 = null;
    try {
      const rd = await fetch(`${CB}/products/BTC-USD/candles?granularity=86400`, H);
      if (rd.ok) {
        const rawD = await rd.json();
        if (Array.isArray(rawD) && rawD.length >= 8) {
          const d = rawD.filter(x => Array.isArray(x) && x[4] > 0).sort((a, b) => a[0] - b[0]);
          const n = d.length;
          if (n >= 8 && d[n - 8][4] > 0) {
            ret7 = Math.round((d[n - 1][4] / d[n - 8][4] - 1) * 1000) / 10;
          }
        }
      }
    } catch { }

    return {
      price: px,
      ema20: e,
      above: e != null && px > e,
      pct1h: prev ? Math.round((px / prev - 1) * 1000) / 10 : 0,
      distPct: e ? Math.round((px / e - 1) * 1000) / 10 : null,
      ret7,
      at: Date.now(),
    };
  } catch { return null; }
}

/**
 * Полный проход по ликвидным парам.
 * @param volumeCache Map<symbol, usdVolume> — общий кеш сервера, чтобы не
 *        тратить лишние запросы на /stats
 */
async function scanMarket(volumeCache, opts = {}) {
  const minVol = opts.minVol || 500e3;
  const maxCoins = opts.maxCoins || 160;
  const onProgress = opts.onProgress || (() => { });

  const prodRes = await fetch(`${CB}/products`, H);
  const products = await prodRes.json();
  const pairs = (Array.isArray(products) ? products : [])
    .filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map(p => p.base_currency)
    .filter(s => !STABLE.has(s));

  // Ликвидные — по уже собранному кешу объёмов
  const universe = pairs
    .map(s => ({ coin: s, vol: volumeCache.get(s) || 0 }))
    .filter(x => x.vol >= minVol)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, maxCoins);

  const regime = await fetchBtcRegime();
  const results = [];
  let scanned = 0;

  for (let i = 0; i < universe.length; i += 3) {
    const batch = universe.slice(i, i + 3);
    await Promise.all(batch.map(async ({ coin, vol }) => {
      try {
        const s = await scalp.fetchScalpSignals(coin);
        if (!s) return;
        // Спред считаем только для кандидатов — лишний запрос на каждую монету дорог
        const near = s.rangePos < 0.4 && s.aboveE9;
        let spread = null;
        if (near) {
          try {
            const r = await fetch(`${CB}/products/${coin}-USD/ticker`, H);
            if (r.ok) {
              const t = await r.json();
              const bid = parseFloat(t.bid), ask = parseFloat(t.ask);
              if (bid > 0 && ask > 0) spread = (ask - bid) / ((ask + bid) / 2) * 100;
            }
          } catch { }
        }
        const sc = scalp.calcScalpScore(s, vol, spread);
        if (!sc) return;
        applyRegime(sc, regime);
        results.push({ coin, pair: `${coin}-USD`, price: s.price, vol24: vol, ...sc });
      } catch { }
    }));
    scanned += batch.length;
    onProgress(scanned, universe.length);
    await sleep(140);
  }

  results.sort((a, b) => b.score - a.score);
  return { results, regime, total: universe.length, at: Date.now() };
}

/**
 * Add market-regime conditions to a structural candidate. Missing regime data
 * is a failed condition, never a permission to trade.
 */
function applyRegime(sc, regime) {
  // Market-regime data is defensive: unavailable data closes the condition.
  sc.regimeOk = regime ? !!regime.above : false;
  sc.checks.push({
    k: 'BTC выше EMA20 (1ч)',
    en: 'BTC above EMA20 (1h)',
    ok: sc.regimeOk,
    v: regime ? (regime.above ? `+${regime.distPct}% над EMA20` : `${regime.distPct}% под EMA20`) : 'ещё не посчитан',
  });
  // The weekly BTC condition is defensive; its combined performance is evaluated only by validate-gate.js.
  const weekOk = !!(regime && regime.ret7 != null && regime.ret7 > 0);
  sc.checks.push({
    k: 'Неделя BTC в плюсе',
    en: 'BTC 7-day return positive',
    ok: weekOk,
    v: regime && regime.ret7 != null ? `${regime.ret7 >= 0 ? '+' : ''}${regime.ret7}% за 7д` : 'ещё не посчитан',
  });
  if (!weekOk) sc.regimeOk = false;
  if (!sc.regimeOk) {
    sc.pass = false;
    // Не обрезаем по 60, а сжимаем шкалу в 0–60: обрезка схлопывала в ровно 60
    // всё, что было выше, и таблица показывала один и тот же балл монете с
    // 6/6 условий и монете с 1/6. Порядок важен именно тут — по нему видно,
    // кто первым станет входом, когда рынок развернётся. Инвариант «86+ ⇔
    // ВХОД» сохраняется: выше 60 при закрытом режиме не поднимется никто.
    sc.scoreRaw = sc.score;
    sc.score = Math.max(0, Math.round(sc.score * 0.6));
    // Собственный вердикт монеты сохраняем: режим — состояние всего рынка, и
    // повторять «РЫНОК ПРОТИВ» в каждой строке таблицы бессмысленно. Интерфейс
    // показывает его один раз полосой, а в строках оставляет то, что говорит
    // сама монета.
    sc.tagOwn = sc.tag;
    if (sc.tag === 'ВХОД' || sc.tag === 'БЛИЗКО') sc.tag = 'РЫНОК ПРОТИВ';
  }
  sc.passed = sc.checks.filter(c => c.ok).length;
  return sc;
}

module.exports = { scanMarket, fetchBtcRegime, applyRegime, STABLE };
