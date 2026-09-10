// Сверка зашитой сетки возврата с сегодняшним рынком.
//
// В server.js стоит таблица recoveryOdds() и дата замера. Это фотография:
// рынок съедет, а числа останутся, и заметить это неоткуда — они не протухают
// громко, они протухают молча, и панель продолжает обещать 89% там, где их
// давно нет.
//
// Скрипт меряет заново теми же правилами, что и measure-recovery.js, но по
// ДВУМЕРНОЙ сетке — глубина за сутки × откат от получасового максимума, как в
// коде, — и сравнивает с тем, что реально зашито. Числа для сравнения берутся
// из самого server.js: вбитая сюда копия однажды уже отстала на целое
// измерение и молча сверяла код с несуществующей таблицей.
//
// Расхождением считается выход за две стандартные ошибки И больше трёх
// пунктов сразу. Одной статистической значимости мало: на 60 тысячах точек
// значимым становится и разница в полтора пункта, которая ничего не меняет.
//
// Запуск:  node scripts/recheck-recovery.js [монет] [дней]
// Выход:   0 — сетка держится, 1 — разошлась (или данных не хватило)
const fs = require('fs');
const path = require('path');

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');

const COINS = Number(process.argv[2] || 30);
const DAYS = Number(process.argv[3] || 25);
const NEED = 0.30;                       // окупает круг комиссии маркет+лимитка
const DEEP = 1.5;                        // порог отката, при котором он начинает добавлять
const WINDOW = 864, DAY = 288;           // в пятиминутных свечах: 3 суток и сутки

const fallPct = (high, price) => (high - price) / high * 100;

// ── зашитая сетка: читаем из кода, а не помним ──────────────────────────────
function shippedGrid() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const body = src.slice(src.indexOf('function recoveryOdds'));
  const grid = [];
  for (const m of body.matchAll(
    /if \(d >= (\d+)\) return deep \? \{ hour: (\d+),[^}]*\} : \{ hour: (\d+),/g)) {
    grid.push({ lo: Number(m[1]), deep: Number(m[2]), shallow: Number(m[3]) });
  }
  const tail = body.match(/return \{ hour: (\d+), stuck: [\d.]+, deep: false \};/);
  if (tail) grid.push({ lo: 0, deep: null, shallow: Number(tail[1]) });
  const at = (src.match(/RECOVERY_MEASURED_AT = '([^']+)'/) || [])[1] || null;
  const n = (src.match(/RECOVERY_SAMPLE = (\d+)/) || [])[1] || null;
  // Порог, ниже которого монета в панель не попадает: там числа сетки никому
  // не показываются, и сравнивать их не с чем.
  const gate = Number((src.match(/const ENTRY_GATE_FALL = ([\d.]+)/) || [])[1]);
  return { grid: grid.sort((a, b) => a.lo - b.lo), at, n: n && Number(n), gate };
}

async function candles(pair, fromMs, toMs) {
  const out = [];
  let cur = fromMs;
  while (cur < toMs) {
    const end = Math.min(toMs, cur + 299 * 300_000);
    try {
      const r = await fetch(`${CB}/products/${pair}/candles?granularity=300` +
        `&start=${new Date(cur).toISOString()}&end=${new Date(end).toISOString()}`, H);
      if (r.ok) {
        const raw = await r.json();
        if (Array.isArray(raw)) for (const c of raw) out.push({ t: +c[0], lo: +c[1], hi: +c[2], cl: +c[4] });
      }
    } catch { }
    await sleep(230);
    cur = end;
  }
  const seen = new Set();
  return out.filter(c => c.t && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}

(async () => {
  const { grid, at, n: sampleN, gate } = shippedGrid();
  if (grid.length < 4) { console.log('ПЛОХО: не разобрал таблицу в server.js'); process.exit(1); }

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }
  const to = Date.now(), from = to - DAYS * 86400000;

  // Свежесть кеша важнее его наличия: вчерашние свечи отвечают на вчерашний
  // вопрос, а весь смысл сверки в том, что рынок мог смениться.
  const stale = (cs) => !cs || !cs.length || (to - cs[cs.length - 1].t * 1000) > 36 * 3600 * 1000;
  const need = Object.keys(cache).filter(c => stale(cache[c])).length;
  if (Object.keys(cache).length < COINS || need) {
    const prods = await (await fetch(`${CB}/products`, H)).json();
    const usd = prods.filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled);
    const vols = [];
    for (const p of usd.slice(0, 140)) {
      try {
        const st = await (await fetch(`${CB}/products/${p.id}/stats`, H)).json();
        const v = Number(st.volume) * Number(st.last);
        if (v > 0) vols.push({ coin: p.base_currency, pair: p.id, v });
      } catch { }
      await sleep(110);
    }
    const list = vols.sort((a, b) => b.v - a.v).slice(0, COINS);
    let k = 0;
    for (const { coin, pair } of list) {
      k++;
      if (!stale(cache[coin]) && cache[coin].length > DAYS * 250) continue;
      process.stdout.write('\r  качаю ' + coin + ' (' + k + '/' + list.length + ')      ');
      cache[coin] = await candles(pair, from, to);
      try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { }
    }
    console.log('');
  }

  // ── замер ────────────────────────────────────────────────────────────────
  const rows = [];
  for (const coin in cache) {
    const cs = cache[coin];
    if (!cs || cs.length < DAY + WINDOW + 300) continue;
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

      const pull = fallPct(hi30, px);
      const fall = fallPct(hiDay, px);
      const tp = px * (1 + NEED / 100);
      let hitMin = null;
      for (let k = i + 1; k < cs.length; k++) {
        const dt = (cs[k].t - t0) / 60;
        if (dt > 60) break;
        if (cs[k].hi >= tp) { hitMin = dt; break; }
      }
      rows.push({ fall, pull, hit: hitMin != null });
    }
  }

  const bandHi = (lo) => {
    const next = grid.filter(g => g.lo > lo).map(g => g.lo).sort((a, b) => a - b)[0];
    return next == null ? Infinity : next;
  };
  const measure = (list) => {
    if (list.length < 200) return null;
    const p = list.filter(r => r.hit).length / list.length;
    // Стандартная ошибка доли: без неё нельзя сказать, разошлось или шумит
    return { n: list.length, pct: p * 100, se: Math.sqrt(p * (1 - p) / list.length) * 100 };
  };

  console.log('\nмонет ' + Object.keys(cache).length + ', точек ' + rows.length +
    ', возврат = +' + NEED + '% за час');
  console.log('зашито ' + (at || '?') + (sampleN ? ' на ' + sampleN.toLocaleString('ru-RU') + ' точках' : '') + '\n');
  console.log('  падение        откат        зашито   сейчас        n');

  let drift = [];
  let thin = 0, measured = 0;
  for (const g of grid) {
    const hi = bandHi(g.lo);
    const label = hi === Infinity ? ('более ' + g.lo + '%') : (g.lo + '-' + hi + '%');
    const inBand = rows.filter(r => r.fall >= g.lo && r.fall < hi);
    for (const [key, want, name] of [['shallow', g.shallow, 'мельче ' + DEEP + '%'],
                                     ['deep', g.deep, 'от ' + DEEP + '%']]) {
      if (want == null) continue;
      const m = measure(inBand.filter(r => (key === 'deep') === (r.pull >= DEEP)));
      if (!m) { thin++; console.log('  ' + label.padEnd(14) + name.padEnd(13) + String(want).padStart(5) + '%    мало данных'); continue; }
      // Полосы мельче входного порога печатаем, но тревогой не считаем.
      //
      // Зашитые числа там мерились на другой совокупности: у панели тогда был
      // отбор по баллу, а балл сильнее всего резал именно мелкий откат при
      // мелком падении. Сравнивать с ними нечестно, а главное — незачем: с
      // падением меньше входного порога монета в панель не попадает, и эти
      // клетки никому не показываются.
      const shown = g.lo >= gate;
      if (shown) measured++;
      const diff = m.pct - want;
      // Две ошибки И три пункта: одной значимости мало, на 80 тысячах точек
      // значимой становится и разница, которая ничего не меняет.
      const off = shown && Math.abs(diff) > 2 * m.se && Math.abs(diff) > 3;
      if (off) drift.push({ label, name, want, got: m.pct, se: m.se, n: m.n });
      console.log('  ' + label.padEnd(14) + name.padEnd(13) + String(want).padStart(5) + '%   ' +
        m.pct.toFixed(1).padStart(5) + '% ±' + m.se.toFixed(1) + '  ' +
        String(m.n).padStart(7) + (off ? '   ← РАЗОШЛОСЬ' : shown ? '' : '   (в панель не попадает)'));
    }
  }

  if (thin) console.log('\n  клеток без данных: ' + thin);
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
        '%, сейчас ' + d.got.toFixed(1) + '% ±' + d.se.toFixed(1) + ' (' + d.n + ' точек)');
    }
    process.exit(1);
  }
  console.log('\nсетка держится: все клетки в пределах двух ошибок или трёх пунктов');
})();
