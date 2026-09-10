// Сверка зашитой сетки возврата с сегодняшним рынком.
//
// В server.js стоит таблица recoveryOdds() и дата замера. Это фотография:
// рынок съедет, а числа останутся, и заметить это неоткуда — они не протухают
// громко, они протухают молча, и панель продолжает обещать 89% там, где их
// давно нет.
//
// ── ЧЕМ МЕРИТЬ НЕЛЬЗЯ ───────────────────────────────────────────────────────
//
// Первая версия считала стандартную ошибку доли по числу ТОЧЕК: 11 250 точек,
// ±0.4 пункта. И на первом же ночном прогоне прислала ложную тревогу.
//
// Точки не независимы. Окна перекрываются, соседние отстоят на пятнадцать
// минут внутри трёхсуточного окна, и все они принадлежат трём десяткам монет.
// А монеты в одной и той же клетке ведут себя совершенно по-разному:
//
//   падение 3-6%, откат мельче 1.5%:  от 39% (BNB) до 84% (DRV)
//   падение 0-1%:                     от 36% (BTC) до 87% (APR)
//
// Настоящая неопределённость — разброс МЕЖДУ монетами, и он вчетверо больше:
// ±1.2 пункта вместо ±0.28. Поэтому доля считается по монетам: сначала своя
// доля у каждой, потом среднее и ошибка среднего по ним. Так же меняется и
// смысл числа: это «сколько у типичной монеты», а не «сколько у той, что дала
// больше всего точек».
//
// ── КАКИЕ МОНЕТЫ БРАТЬ ──────────────────────────────────────────────────────
//
// Те же, что видит панель: самые ликвидные, тем же порогом объёма и тем же
// числом. Прежняя версия мерила ВСЁ, что осталось в кеше, — и один прогон шёл
// по 30 монетам, другой по 68. Разница между такими прогонами доходила до
// двенадцати пунктов в клетке, и это была разница корзин, а не рынка.
//
// Запуск:  node scripts/recheck-recovery.js [дней]
// Выход:   0 — сетка держится, 1 — разошлась или сверка не состоялась
const fs = require('fs');
const path = require('path');

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
const NEED = 0.30;                       // окупает круг комиссии маркет+лимитка
const DEEP = 1.5;                        // порог отката, при котором он начинает добавлять
const WINDOW = 864, DAY = 288;           // в пятиминутных свечах: 3 суток и сутки
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

const fallPct = (high, price) => (high - price) / high * 100;

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
  let cur = fromMs;
  while (cur < toMs) {
    const end = Math.min(toMs, cur + 299 * 300_000);
    // Биржа отвечает отказом при частых запросах. Без повтора кусок ряда
    // просто пропадал, и монета выглядела так, будто по ней нет истории: на
    // одном прогоне так «исчезли» двадцать три монеты из шестидесяти.
    // Отступ растёт, иначе повторы бьются в ту же стену.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${CB}/products/${pair}/candles?granularity=300` +
          `&start=${new Date(cur).toISOString()}&end=${new Date(end).toISOString()}`, H);
        if (r.ok) {
          const raw = await r.json();
          if (Array.isArray(raw)) for (const c of raw) out.push({ t: +c[0], lo: +c[1], hi: +c[2], cl: +c[4] });
          paceDown();
          break;
        }
      } catch { }
      paceUp();
      await sleep([1000, 3000, 8000, 0][attempt]);
    }
    await sleep(pace);
    cur = end;
  }
  const seen = new Set();
  return out.filter(c => c.t && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}

// Доли по монетам: среднее и ошибка среднего ПО МОНЕТАМ, не по точкам
function cellStats(perCoin, lo, hi, deep) {
  const parts = [];
  for (const coin in perCoin) {
    const g = perCoin[coin].filter(r => r.fall >= lo && r.fall < hi && (r.pull >= DEEP) === deep);
    if (g.length < MIN_PER_COIN) continue;
    parts.push({ coin, p: g.filter(r => r.hit).length / g.length * 100, n: g.length });
  }
  if (parts.length < MIN_COINS) return { thin: true, coins: parts.length };
  const m = parts.reduce((s, x) => s + x.p, 0) / parts.length;
  const sd = Math.sqrt(parts.reduce((s, x) => s + (x.p - m) ** 2, 0) / (parts.length - 1));
  const sorted = [...parts].sort((a, b) => a.p - b.p);
  return {
    pct: m, se: sd / Math.sqrt(parts.length), sd,
    coins: parts.length, n: parts.reduce((s, x) => s + x.n, 0),
    lowest: sorted[0], highest: sorted[sorted.length - 1],
  };
}

(async () => {
  const S = shippedGrid();
  if (S.grid.length < 4) { console.log('ПЛОХО: не разобрал таблицу в server.js'); process.exit(1); }

  // ── корзина: та же, что у панели ─────────────────────────────────────────
  const prods = await (await fetch(`${CB}/products`, H)).json();
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
  const to = Date.now(), from = to - DAYS * 86400000;
  // Вчерашние свечи отвечают на вчерашний вопрос, а весь смысл сверки в том,
  // что рынок мог смениться.
  const stale = (cs) => !cs || !cs.length || (to - cs[cs.length - 1].t * 1000) > 36 * 3600 * 1000;
  const fetchCoin = async (coin, pair, tag) => {
    process.stdout.write('\r  качаю ' + coin + ' ' + tag + ' (темп ' + pace + ' мс)        ');
    const got = await candles(pair, from, to);
    // НЕ затирать хорошее плохим. Первая версия писала в кеш что угодно, и
    // отказ биржи стирал месяц истории по монете: следующий прогон видел ноль
    // свечей и молча выкидывал её из замера.
    if (got.length > DAYS * 150) {
      cache[coin] = got;
      try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { }
      return true;
    }
    return false;
  };

  let k = 0, failed = [];
  for (const { coin, pair } of basket) {
    k++;
    if (!stale(cache[coin]) && cache[coin].length > DAYS * 250) continue;
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
  for (const { coin } of basket) {
    const cs = cache[coin];
    if (!cs || cs.length < DAY + WINDOW + 300) continue;
    const rows = [];
    for (let i = DAY; i < cs.length - WINDOW; i += 3) {
      const px = cs[i].cl;
      if (!(px > 0)) continue;
      // Окна назад ПО ВРЕМЕНИ, а не по числу свечей: ряд неразрывен только
      // пока идут сделки, и по индексам треть суточных окон уезжала за сутки.
      const t0 = cs[i].t;
      const w30 = cs.slice(Math.max(0, i - 40), i + 1).filter(c => t0 - c.t <= 30 * 60);
      const wDay = cs.slice(Math.max(0, i - DAY * 3), i + 1).filter(c => t0 - c.t <= 24 * 3600);
      if (w30.length < 2 || wDay.length < 30) continue;
      const hi30 = Math.max(...w30.map(c => c.hi));
      const hiDay = Math.max(...wDay.map(c => c.hi));
      if (!(hi30 > 0) || !(hiDay > 0)) continue;
      const tp = px * (1 + NEED / 100);
      let hit = false;
      for (let j = i + 1; j < cs.length; j++) {
        const dt = (cs[j].t - t0) / 60;
        if (dt > 60) break;
        if (cs[j].hi >= tp) { hit = true; break; }
      }
      rows.push({ fall: fallPct(hiDay, px), pull: fallPct(hi30, px), hit });
    }
    perCoin[coin] = rows;
  }

  const bandHi = (lo) => {
    const next = S.grid.filter(g => g.lo > lo).map(g => g.lo).sort((a, b) => a - b)[0];
    return next == null ? Infinity : next;
  };

  const totalPts = Object.values(perCoin).reduce((s, r) => s + r.length, 0);
  console.log('\nкорзина ' + Object.keys(perCoin).length + ' монет (как у панели: топ ' + S.maxCoins +
    ' по объёму от $' + (S.minVol / 1e6) + 'М), точек ' + totalPts);
  console.log('зашито ' + (S.at || '?') + (S.n ? ' на ' + S.n.toLocaleString('ru-RU') + ' точках' : '') +
    (Object.keys(S.se).length ? '' : ' — ошибка того замера неизвестна, сравниваю по своей'));
  console.log('\nдоля и ошибка — ПО МОНЕТАМ: точки внутри монеты не независимы\n');
  console.log('  падение        откат         зашито    сейчас         монет   разброс между монетами');

  const drift = [];
  let thin = 0, measured = 0;
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
      // Ошибка РАЗНОСТИ: у зашитого числа она тоже есть. Если её не знаем,
      // берём сегодняшнюю — вдвое осторожнее, чем считать зашитое точным.
      const seWas = S.se[cellKey] != null ? S.se[cellKey] : m.se;
      const seDiff = Math.sqrt(m.se * m.se + seWas * seWas);
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

  // Слепая сверка опаснее её отсутствия: она молчит и этим говорит «всё
  // хорошо». Если мерить было нечего вообще — это сбой, а не спокойствие.
  if (!measured) {
    console.log('\nСВЕРКА НЕ СОСТОЯЛАСЬ: ни одной клетки с достаточными данными');
    process.exit(1);
  }
  if (drift.length) {
    console.log('\nРАЗОШЛОСЬ в ' + drift.length + ' клетках — сетку пора перемерить и обновить дату:');
    for (const d of drift) {
      console.log('  ' + d.label + ' / откат ' + d.name + ': зашито ' + d.want +
        '%, сейчас ' + d.got.toFixed(1) + '% (ошибка разности ±' + d.seDiff.toFixed(2) +
        ', ' + d.coins + ' монет)');
    }
    process.exit(1);
  }
  console.log('\nсетка держится: все клетки в пределах двух ошибок или трёх пунктов');
})();
