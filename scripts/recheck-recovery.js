// Сверка исторической сетки на данных после даты исходного замера.
// Часовой исход использует полные свечи и те же расстояния, что live.
// Код 0: расхождений не обнаружено; 1: расхождение/ошибка; 2: неполная сверка.
// Запуск: node scripts/recheck-recovery.js [дней] [--cache-only]
const fs = require('fs');
const path = require('path');
const { sampleWindows, historyReady } = require('../src/recovery/recheck');

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');
const ROOT = path.join(__dirname, '..');

// Флаги отделяем от числа дней. Раньше бралось просто argv[2], и запуск с
// --se давал DAYS = NaN: окно закачки становилось NaN, каждый запрос падал на
// невалидной дате, и все шестьдесят монет «не докачались».
const DAYS = Number(process.argv.slice(2).find(a => !a.startsWith('-')) || 25);
if (!Number.isFinite(DAYS) || DAYS < 3) { console.log('ПЛОХО: дней должно быть число от 3'); process.exit(1); }
const NEED = 0.30;                       // ценовая цель до издержек
const DEEP = 1.5;                        // порог отката, при котором он начинает добавлять
// Сколько точек нужно у монеты, чтобы её доля пошла в счёт.
//
// Было сто — и главные клетки просто не проверялись: глубокий откат редок, и
// сотню точек в нём набирали от одной до восьми монет из полусотни. При
// тридцати их становится 28-49, то есть клетки наконец видны.
//
// Плата за это — в разбросе между монетами оседает и собственный шум коротких
// выборок, поэтому ошибка выходит завышенной. Ошибаться в эту сторону здесь
// правильно: ложная тревога стоит доверия ко всей сверке.
const MIN_PER_COIN = 30;
const MIN_COINS = 12;                    // меньше — по клетке нечего говорить

// Стейблкоины считать нельзя: у USDT возврат «0%», и он тянет среднее вниз,
// хотя панель такие монеты не показывает вовсе.
const { STABLE } = require(path.join(__dirname, '..', 'src', 'scalp', 'scanner'));


// ── что зашито: читаем из кода, а не помним ─────────────────────────────────
function shippedGrid() {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const body = src.slice(src.indexOf('function recoveryOdds'));
  const grid = [];
  for (const m of body.matchAll(
    /if \(d >= (\d+)\) return deep \? \{ hour: (\d+),[^}]*\} : \{ hour: (\d+),/g)) {
    grid.push({ lo: Number(m[1]), deep: Number(m[2]), shallow: Number(m[3]) });
  }
  const tail = body.match(/return \{ hour: (\d+), stuck: [\d.]+, deep: false \};/);
  if (tail) grid.push({ lo: 0, deep: null, shallow: Number(tail[1]) });

  // Ошибка того замера, на котором сетка построена. Без неё сравнение
  // однобокое: у измеренного сегодня числа ошибка есть, а у зашитого будто
  // нет — и любое расхождение выглядит значимым.
  const se = {};
  const seSrc = src.match(/const RECOVERY_SE = \{([\s\S]*?)\};/);
  if (seSrc) for (const m of seSrc[1].matchAll(/'([^']+)':\s*([\d.]+)/g)) se[m[1]] = Number(m[2]);

  return {
    grid: grid.sort((a, b) => a.lo - b.lo),
    se,
    at: (src.match(/RECOVERY_MEASURED_AT = '([^']+)'/) || [])[1] || null,
    n: Number((src.match(/RECOVERY_SAMPLE = (\d+)/) || [])[1]) || null,
    // Ниже этого падения монета в панель не попадает — там сетка никому не
    // показывается, и сравнивать её не с чем.
    gate: Number((src.match(/const ENTRY_GATE_FALL = ([\d.]+)/) || [])[1]),
    // Корзина панели: столько самых ликвидных монет она и просматривает
    maxCoins: Number((src.match(/const ENTRY_SCAN_MAX_COINS = (\d+)/) || [])[1]) || 60,
    minVol: Number((fs.readFileSync(path.join(ROOT, 'src', 'micro-scalp', 'scanner.js'), 'utf8')
      .match(/const MIN_VOLUME_USD = ([\de.]+)/) || [])[1]) || 2e6,
  };
}

// Темп запросов подстраивается сам. Биржа не отвечает отказом честно и
// одинаково: на длинном прогоне (шесть десятков монет, полторы тысячи
// запросов) она начинает молча ронять часть, и монеты «исчезают» пачками.
// Спотыкнулись — идём медленнее; идём гладко — понемногу ускоряемся.
let pace = 320;
function paceUp() { pace = Math.min(Math.round(pace * 1.6), 2500); }
function paceDown() { pace = Math.max(Math.round(pace * 0.97), 320); }

async function candles(pair, fromMs, toMs) {
  const out = [];
  let complete = true;
  let cur = fromMs;
  while (cur < toMs) {
    const end = Math.min(toMs, cur + 299 * 300_000);
    let loaded = false;
    // Биржа отвечает отказом при частых запросах. Без повтора кусок ряда
    // просто пропадал, и монета выглядела так, будто по ней нет истории: на
    // одном прогоне так «исчезли» двадцать три монеты из шестидесяти.
    // Отступ растёт, иначе повторы бьются в ту же стену.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${CB}/products/${pair}/candles?granularity=300` +
          `&start=${new Date(cur).toISOString()}&end=${new Date(end).toISOString()}`,
          { ...H, signal: AbortSignal.timeout(15000) });
        if (r.ok) {
          const raw = await r.json();
          if (Array.isArray(raw)) {
            for (const c of raw) out.push({ t: +c[0], lo: +c[1], hi: +c[2], cl: +c[4] });
            loaded = true;
            paceDown();
            break;
          }
        }
      } catch { }
      paceUp();
      await sleep([1000, 3000, 8000, 0][attempt]);
    }
    if (!loaded) complete = false;
    await sleep(pace);
    cur = end;
  }
  const seen = new Set();
  return { complete, rows: out.filter(c => c.t && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t) };
}

// Доли по монетам: среднее и ошибка среднего ПО МОНЕТАМ, не по точкам
// Счётчики по клеткам, а не сами точки.
//
// Раньше по каждой монете хранился полный список точек — под сотню тысяч
// объектов разом, поверх двадцати семи мегабайт разобранного кеша свечей.
// Замер идёт НА БОЕВОЙ МАШИНЕ, рядом с торговым процессом, и на тесной по
// памяти машине такой сосед способен утащить сервер за собой. От точки нужны
// только две вещи: в какую клетку она попала и дошла ли до цели.
function cellKey(lo, deep) { return lo + (deep ? 'd' : 's'); }
function tally(counts, rows, bands) {
  for (const r of rows) {
    const band = bands.filter(b => r.fall >= b.lo).sort((a, b) => b.lo - a.lo)[0];
    if (!band) continue;
    const k = cellKey(band.lo, r.pull >= DEEP);
    const c = counts[k] || (counts[k] = { n: 0, hit: 0 });
    c.n++;
    if (r.hit) c.hit++;
  }
}
function cellStats(perCoin, lo, hi, deep) {
  const parts = [];
  const k = cellKey(lo, deep);
  for (const coin in perCoin) {
    const g = perCoin[coin][k];
    if (!g || g.n < MIN_PER_COIN) continue;
    parts.push({ coin, p: g.hit / g.n * 100, n: g.n });
  }
  if (parts.length < MIN_COINS) return { thin: true, coins: parts.length };
  const total = parts.reduce((s, x) => s + x.n, 0);
  const m = parts.reduce((s, x) => s + x.p * x.n, 0) / total;
  const se = Math.sqrt(parts.length / (parts.length - 1) *
    parts.reduce((s, x) => s + ((x.p - m) * x.n / total) ** 2, 0));
  const sorted = [...parts].sort((a, b) => a.p - b.p);
  return {
    pct: m, se,
    coins: parts.length, n: parts.reduce((s, x) => s + x.n, 0),
    lowest: sorted[0], highest: sorted[sorted.length - 1],
    // ДОЛЯ КАЖДОЙ МОНЕТЫ ОТДЕЛЬНО.
    //
    // Среднее по клетке про отдельную монету не говорит почти ничего: при
    // ошибке клетки ±2 п.п. разброс внутри неё — от 22% (BTC) до 91%
    // (USELESS), то есть 60-70 пунктов. Панель показывала это среднее всем
    // строкам разом, и для BTC оно было завышено втрое.
    //
    // Числа считаются здесь же и тем же способом, просто не сворачиваются.
    byCoin: Object.fromEntries(parts.map(x => [x.coin,
      { pct: Math.round(x.p * 10) / 10, n: x.n }])),
  };
}

(async () => {
  const S = shippedGrid();
  if (S.grid.length < 4) { console.log('ПЛОХО: не разобрал таблицу в server.js'); process.exit(1); }

  // ── корзина: та же, что у панели ─────────────────────────────────────────
  const prods = await (await fetch(`${CB}/products`, H)).json();
  if (!Array.isArray(prods)) throw new Error('биржа не вернула список продуктов');
  const usd = prods.filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled);
  // Объёмы одним запросом по всем парам. Раньше бралась первая сотня с
  // хвостиком из списка бирж в её произвольном порядке — это не «самые
  // ликвидные», а «те, что оказались в начале», и корзина выходила случайной.
  const stats = await (await fetch(`${CB}/products/stats`, H)).json();
  const vols = [];
  for (const p of usd) {
    const st = stats[p.id];
    if (!st) continue;
    if (STABLE.has(p.base_currency)) continue;
    const v = Number(st.stats_24hour ? st.stats_24hour.volume : st.volume) *
      Number(st.stats_24hour ? st.stats_24hour.last : st.last);
    if (v >= S.minVol) vols.push({ coin: p.base_currency, pair: p.id, v });
  }
  const basket = vols.sort((a, b) => b.v - a.v).slice(0, S.maxCoins);
  console.log('корзина: ' + basket.length + ' монет, от $' +
    Math.round(basket[basket.length - 1] ? basket[basket.length - 1].v / 1e6 : 0) + 'М суточного объёма');
  if (basket.length < MIN_COINS) { console.log('ПЛОХО: корзина пустая, биржа не ответила'); process.exit(1); }

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }
  const to = Math.floor(Date.now() / 300000) * 300000;
  const trained = Date.parse(S.at);
  if (!Number.isFinite(trained)) throw new Error('неизвестна дата исходного замера');
  const from = Math.max(to - DAYS * 86400000, trained + 86400000);
  const downloadFrom = from - 86400000;
  const verifiedDownloads = new Set();
  const stale = (cs, coin) => !historyReady(cs, downloadFrom, to, verifiedDownloads.has(coin));
  const fetchCoin = async (coin, pair, tag) => {
    if (process.argv.includes('--cache-only')) return false;
    process.stdout.write('\r  качаю ' + coin + ' ' + tag + ' (темп ' + pace + ' мс)        ');
    const old = (cache[coin] || []).filter(c => c.t * 1000 >= downloadFrom && c.t * 1000 < to);
    const needsHistory = !old.length || old[0].t * 1000 > downloadFrom + 3600000;
    const start = needsHistory ? downloadFrom : Math.max(downloadFrom, old[old.length - 1].t * 1000 - 300000);
    const got = await candles(pair, start, to);
    const merged = [...new Map([...old, ...got.rows].map(c => [c.t, c])).values()].sort((a, b) => a.t - b.t);
    if (got.complete && historyReady(merged, downloadFrom, to, true)) {
      verifiedDownloads.add(coin);
      cache[coin] = merged;
      try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { }
      return true;
    }
    return false;
  };

  let k = 0, failed = [];
  for (const { coin, pair } of basket) {
    k++;
    if (!stale(cache[coin], coin)) continue;
    if (!await fetchCoin(coin, pair, '(' + k + '/' + basket.length + ')')) failed.push({ coin, pair });
  }
  // Второй заход по недокачанным: к концу прогона темп уже подстроен, и то,
  // что срывалось на разгоне, обычно доезжает.
  if (failed.length) {
    console.log('\n  повторяю ' + failed.length + ': ' + failed.map(f => f.coin).join(', '));
    const again = [];
    for (const f of failed) if (!await fetchCoin(f.coin, f.pair, '(повтор)')) again.push(f.coin);
    failed = again.map(c => ({ coin: c }));
  }
  console.log('');
  if (failed.length) console.log('  так и не докачались: ' + failed.map(f => f.coin).join(', '));

  // ── замер, только по корзине ─────────────────────────────────────────────
  const perCoin = {};
  let totalPts = 0;
  let evaluatedFrom = Infinity, evaluatedTo = 0;
  for (const { coin } of basket) {
    const cs = cache[coin];
    if (stale(cs, coin)) continue;
    const rows = sampleWindows(cs, { from, to, need: NEED });
    if (!rows.length) continue;
    evaluatedFrom = Math.min(evaluatedFrom, rows[0].at);
    evaluatedTo = Math.max(evaluatedTo, rows[rows.length - 1].at);
    // Сворачиваем точки монеты в счётчики и отпускаем и точки, и её свечи:
    // дальше ни то ни другое не нужно, а память освобождается сразу.
    const counts = {};
    tally(counts, rows, S.grid);
    perCoin[coin] = counts;
    totalPts += rows.length;
    delete cache[coin];
  }

  const bandHi = (lo) => {
    const next = S.grid.filter(g => g.lo > lo).map(g => g.lo).sort((a, b) => a - b)[0];
    return next == null ? Infinity : next;
  };
  console.log('\nкорзина ' + Object.keys(perCoin).length + ' монет (как у панели: топ ' + S.maxCoins +
    ' по объёму от $' + (S.minVol / 1e6) + 'М), точек ' + totalPts);
  console.log('зашито ' + (S.at || '?') + (S.n ? ' на ' + S.n.toLocaleString('ru-RU') + ' точках' : '') +
    (Object.keys(S.se).length ? '' : ' — ошибка того замера неизвестна, сравниваю по своей'));
  console.log('\nДоля по наблюдениям; ошибка с группировкой по монетам. Диагностическая оценка, без исторического спреда.\n');
  console.log('  падение        откат         зашито    сейчас         монет   разброс между монетами');

  const drift = [];
  let thin = 0, thinShown = 0, measured = 0;
  const cellReport = [];
  const fresh = {};
  for (const g of S.grid) {
    const hi = bandHi(g.lo);
    const label = hi === Infinity ? ('более ' + g.lo + '%') : (g.lo + '-' + hi + '%');
    for (const [key, want, name] of [['shallow', g.shallow, 'мельче ' + DEEP + '%'],
                                     ['deep', g.deep, 'от ' + DEEP + '%']]) {
      if (want == null) continue;
      const cellKey = g.lo + (key === 'deep' ? 'd' : 's');
      const m = cellStats(perCoin, g.lo, hi, key === 'deep');
      if (m.thin) {
        thin++;
        if (g.lo >= S.gate) thinShown++;
        cellReport.push({ lo: g.lo, deep: key === 'deep', thin: true, coins: m.coins });
        console.log('  ' + label.padEnd(14) + name.padEnd(14) + String(want).padStart(5) + '%    монет всего ' + m.coins + ' — мало');
        continue;
      }
      fresh[cellKey] = Math.round(m.se * 100) / 100;

      // Полосы мельче входного порога печатаем, но тревогой не считаем: с
      // таким падением монета в панель не попадает, и эти клетки никому не
      // показываются. Зашитые там числа к тому же мерились на другой
      // совокупности — у панели тогда был отбор по баллу.
      const shown = g.lo >= S.gate;
      if (shown) measured++;
      const diff = m.pct - want;
      cellReport.push({ lo: g.lo, deep: key === 'deep', promised: want, actual: m.pct, se: m.se,
        coins: m.coins, n: m.n, byCoin: m.byCoin });
      // Ошибка РАЗНОСТИ: у зашитого числа она тоже есть. Если её не знаем,
      // берём сегодняшнюю — вдвое осторожнее, чем считать зашитое точным.
      // Ошибка старого замера была посчитана для других весов. Её нельзя
      // выдавать за ошибку исходной сетки; используем диагностический допуск.
      const seDiff = Math.SQRT2 * m.se;
      // Две ошибки И три пункта: одной значимости мало, а три пункта — та
      // величина, ниже которой обещание панели не меняется на глаз.
      const off = shown && Math.abs(diff) > 2 * seDiff && Math.abs(diff) > 3;
      if (off) drift.push({ label, name, want, got: m.pct, seDiff, coins: m.coins });
      console.log('  ' + label.padEnd(14) + name.padEnd(14) + String(want).padStart(5) + '%   ' +
        m.pct.toFixed(1).padStart(5) + '% ±' + m.se.toFixed(2).padEnd(5) + '  ' +
        String(m.coins).padStart(5) + '   от ' + m.lowest.p.toFixed(0) + '% (' + m.lowest.coin +
        ') до ' + m.highest.p.toFixed(0) + '% (' + m.highest.coin + ')' +
        (off ? '   ← РАЗОШЛОСЬ' : shown ? '' : '   (в панель не попадает)'));
    }
  }

  if (thin) console.log('\n  клеток без данных: ' + thin);
  if (process.argv.includes('--se')) {
    console.log('\nдля RECOVERY_SE в server.js:');
    console.log('  ' + Object.entries(fresh).map(([k, v]) => "'" + k + "': " + v).join(', '));
  }

  const incomplete = thinShown > 0 || measured < S.grid.filter(g => g.lo >= S.gate)
    .reduce((n, g) => n + 1 + Number(g.deep != null), 0) || failed.length > 0;
  const status = drift.length ? 'drift' : incomplete ? 'incomplete' : 'no-drift';
  console.log('RECHECK_RESULT ' + JSON.stringify({
    version: 2, status, from, to, referenceDate: S.at,
    evaluatedFrom: Number.isFinite(evaluatedFrom) ? evaluatedFrom : null,
    evaluatedTo: evaluatedTo || null, coins: Object.keys(perCoin).length, points: totalPts,
    missingCoins: failed.map(x => x.coin), cells: cellReport,
    basis: 'полные часовые окна после даты исходного замера; без исторического спреда',
  }));
  if (drift.length) {
    console.log('\nРАЗОШЛОСЬ в ' + drift.length + ' клетках; нужна проверка сетки, а не автоматическая замена процентов');
    process.exitCode = 1;
  } else if (incomplete) {
    console.log('\nСВЕРКА НЕПОЛНАЯ: не все клетки и монеты имеют достаточные свежие данные');
    process.exitCode = 2;
  } else {
    console.log('\nРасхождений с сеткой не обнаружено в проверенном периоде. Это не доказательство прибыльности.');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
