// Замер долей возврата, зашитых в recoveryOdds() в server.js.
//
// Что меряем: покупаем в момент t, ждём, пока цена поднимется на +0.30% выше
// входа (это окупает круг комиссии маркет+лимитка), и смотрим, за сколько это
// произошло и произошло ли вообще за трое суток. Группируем по глубине падения
// от суточного максимума.
//
// Считаются ТОЛЬКО те точки, что попадают в панель, то есть с баллом 40+.
// Первая версия скрипта мерила все подряд, а это другая совокупность: у самой
// глубокой группы получалось 89% возврата вместо настоящих 75%.
//
// Свечи пятиминутные: возврат меряется с точностью до пяти минут, минутного
// разрешения тут не нужно, а качать в пять раз меньше. Кеш общий с
// measure-runup.js, так что второй запуск идёт сразу.
//
// Запуск:  node scripts/measure-recovery.js [монет] [дней]
const fs = require('fs');
const path = require('path');

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = path.join(require('os').tmpdir(), 'runup-5m.json');

const COINS = Number(process.argv[2] || 30);
const DAYS = Number(process.argv[3] || 25);
const NEED = 0.30;
const H1 = 12, H6 = 72, H24 = 288, WINDOW = 864, DAY = 288;   // в 5-минутных свечах

// Падение считается долей самого максимума, а не «на сколько цене надо
// вырасти обратно»: прежняя формула (hi/px−1) завышала глубину, её 10% это
// настоящие 9.1%.
const fallPct = (high, price) => (high - price) / high * 100;

// Те же полосы, что в microScalpEntryValue: совокупность обязана совпадать.
const band = (v, a, b, c, d) => v <= a || v >= d ? 0 : v < b ? (v - a) / (b - a) : v > c ? (d - v) / (d - c) : 1;
const rsi14 = c => {
  if (c.length < 15) return null;
  let u = 0, d = 0;
  for (let i = c.length - 14; i < c.length; i++) { const x = c[i] - c[i - 1]; if (x >= 0) u += x; else d -= x; }
  return d === 0 ? 100 : 100 - 100 / (1 + (u / 14) / (d / 14));
};

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
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }

  if (Object.keys(cache).length < COINS) {
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
    const to = Date.now(), from = to - DAYS * 86400000;
    let n = 0;
    for (const { coin, pair } of list) {
      n++;
      if (cache[coin] && cache[coin].length > DAYS * 250) continue;
      process.stdout.write('\r  качаю ' + coin + ' (' + n + '/' + list.length + ')      ');
      cache[coin] = await candles(pair, from, to);
      fs.writeFileSync(CACHE, JSON.stringify(cache));
    }
    console.log('');
  }

  const rows = [];
  for (const coin in cache) {
    const cs = cache[coin];
    if (cs.length < DAY + WINDOW + 300) continue;
    for (let i = DAY; i < cs.length - WINDOW; i += 3) {
      const px = cs[i].cl;
      if (!(px > 0)) continue;
      // Окна назад по времени, а не по числу свечей — как в entrySignals.
      const t0w = cs[i].t;
      const w30 = cs.slice(Math.max(0, i - 40), i + 1).filter(c => t0w - c.t <= 30 * 60);
      const wDay = cs.slice(Math.max(0, i - DAY * 3), i + 1).filter(c => t0w - c.t <= 24 * 3600);
      if (w30.length < 2 || wDay.length < 30) continue;
      const hi30 = Math.max(...w30.map(c => c.hi));
      if (!(hi30 > 0)) continue;
      const pull = fallPct(hi30, px);
      const rsi = rsi14(cs.slice(i - 14, i + 1).map(c => c.cl));
      if (rsi == null) continue;
      if (100 * band(pull, 0.15, 0.40, 0.80, 1.50) * band(rsi, 20, 28, 45, 58) < 40) continue;

      const hiDay = Math.max(...wDay.map(c => c.hi));
      if (!(hiDay > 0)) continue;
      const fall = fallPct(hiDay, px);

      // Считаем ПО ВРЕМЕНИ, а не по числу свечей. Ряд свечей неразрывен только
      // пока идут сделки: на 209 295 проверенных пар 30.17% окон «12 свечей
      // вперёд» оказались длиннее часа, худшее растянулось на 1180 минут. По
      // индексам доли выходили завышенными на 1-4 пункта.
      const t0 = cs[i].t;
      const tp = px * (1 + NEED / 100);
      let hitMin = null;
      for (let k = i + 1; k < cs.length; k++) {
        const dt = (cs[k].t - t0) / 60;
        if (dt > WINDOW * 5) break;
        if (cs[k].hi >= tp) { hitMin = dt; break; }
      }
      rows.push({ fall, hitMin });
    }
  }

  const pct = (a, f) => a.length ? a.filter(f).length / a.length * 100 : 0;
  console.log('\nмонет ' + Object.keys(cache).length + ', точек входа с баллом 40+: ' + rows.length);
  console.log('возврат = +' + NEED + '% выше входа, окно ' + (WINDOW / DAY) + ' сут\n');
  console.log('  падение от суточного максимума    n      за час   за 6ч   за 24ч   НЕ вернулось');
  const B = [[0, 1], [1, 3], [3, 6], [6, 10], [10, 1e9]];
  const got = [];
  for (const [lo, hi] of B) {
    const g = rows.filter(r => r.fall >= lo && r.fall < hi);
    if (g.length < 50) { console.log('  ' + (lo + '-' + hi).padEnd(34) + 'мало (' + g.length + ')'); continue; }
    const label = hi > 1e8 ? ('более ' + lo + '%') : (lo + '-' + hi + '%');
    const h1 = pct(g, r => r.hitMin != null && r.hitMin <= 60);
    got.push(Math.round(h1));
    console.log('  ' + label.padEnd(34) + String(g.length).padStart(5) + '   ' +
      h1.toFixed(0).padStart(6) + '%  ' +
      pct(g, r => r.hitMin != null && r.hitMin <= 360).toFixed(0).padStart(5) + '%  ' +
      pct(g, r => r.hitMin != null && r.hitMin <= 1440).toFixed(0).padStart(6) + '%   ' +
      pct(g, r => r.hitMin == null).toFixed(1).padStart(11) + '%');
  }

  const shipped = [57, 59, 67, 72, 75];
  console.log('\n  зашито в recoveryOdds():  ' + shipped.join(' / '));
  console.log('  получено сейчас:          ' + got.join(' / '));
  const same = got.length === shipped.length && got.every((v, i) => Math.abs(v - shipped[i]) <= 3);
  console.log('  ' + (same ? 'совпадает в пределах трёх пунктов'
    : 'РАЗОШЛОСЬ - рынок сменился, пора обновить таблицу и дату замера'));
})();
