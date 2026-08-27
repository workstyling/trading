/**
 * СКАНЕР СКАЛЬПА ПО ВСЕМУ ЛИКВИДНОМУ РЫНКУ.
 * ────────────────────────────────────────────────────────────────────────
 * Скальп-гейт (у дна 4ч диапазона + RSI 5m из перепроданности + цена выше
 * EMA9) никак не связан с падением за 30 дней — он был откалиброван на 109
 * ликвидных монетах. Привязывать его к Top Losers было ошибкой: половина
 * того списка неликвид, а сам сигнал случается где угодно.
 *
 * РЕЖИМ РЫНКА. Исходный замер (1119 сигналов, 7 дней) давал по часовой
 * EMA20 72% побед против 54% — 18 п.п., и условие строилось на нём.
 * На 25 днях и 1902 входах это НЕ подтвердилось:
 *   BTC выше EMA20 (1ч):  60% побед, −0.103%, PF 0.90
 *   BTC ниже EMA20 (1ч):  59% побед, −0.059%, PF 0.94
 * То есть отбрасываемые входы шли чуть ЛУЧШЕ пропускаемых. Часовая EMA
 * дёргается вместе с рынком и пускает вход прямо в падение. Условие
 * оставлено, но самостоятельной ценности у него не измерено.
 *
 * Что действительно работает — НЕДЕЛЬНАЯ доходность BTC (60 дней, 1893
 * входа, единственный кандидат за всю серию, прошедший все три отрезка):
 *   неделя в плюсе:  66% побед, +0.101%, PF 1.10  (73% потока)
 *   неделя в минусе: 49% побед, −0.500%, PF 0.61  (убыточна на 3/3)
 * Дневная EMA20 проверку не прошла (2/3), порог «неделя > +3%» тоже (2/3):
 * простой знак доходности оказался устойчивее подобранного порога.
 *
 * ВОЗРАСТ СИГНАЛА проверен и НЕ работает: только что сработавший даёт
 * +0.05%, через 5-10 минут +0.144%, через 15-25 минут +0.034% — разброс
 * без закономерности, на трёх отрезках эффекта нет. Не используется.
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

    // Недельная доходность BTC. Единственный фактор, прошедший проверку по
    // всем трём отрезкам на 60 днях и 1893 входах: при положительной неделе
    // ожидание +0.101% и профит-фактор 1.10, при отрицательной -0.500% и
    // 0.61, причём вторая группа убыточна на каждом отрезке. Дневная EMA20
    // такой проверки не прошла, часовая — тем более.
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
 * Режим — жёсткое условие: ниже EMA20 ожидание отрицательное (−0.211%),
 * поэтому вход не выдаём, но монету показываем с честным вердиктом.
 */
function applyRegime(sc, regime) {
  // Пока режим не посчитан (первые ~75 сек после старта) вход НЕ выдаём:
  // раньше отсутствие данных считалось «можно», и колонка могла показать ВХОД
  // при BTC ниже EMA20 — там ожидание −0.211%.
  sc.regimeOk = regime ? !!regime.above : false;
  sc.checks.push({
    k: 'BTC выше EMA20 (1ч)',
    en: 'BTC above EMA20 (1h)',
    ok: sc.regimeOk,
    v: regime ? (regime.above ? `+${regime.distPct}% над EMA20` : `${regime.distPct}% под EMA20`) : 'ещё не посчитан',
  });
  // Недельная доходность BTC — жёсткое условие наравне с часовой EMA20.
  // Замер на 60 днях, 1893 входа: отрицательная неделя даёт -0.500% на
  // сделку при PF 0.61 и убыточна на ВСЕХ трёх отрезках. Отсечение таких
  // входов улучшает каждый отрезок и переводит ожидание из -0.061% в
  // +0.101%, PF из 0.94 в 1.10, сохраняя 73% потока. Как и с часовым
  // условием, отсутствие данных считаем запретом, а не разрешением.
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
