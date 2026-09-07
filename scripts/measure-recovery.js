// Замер долей возврата, которые показывает панель «Лучший вход по рынку».
//
// Числа в recoveryOdds() были получены разовым скриптом и в репозитории не
// лежали — то есть проверить их было нечем. Этот скрипт их воспроизводит.
//
// Что меряем: покупаем в момент t, ждём, пока цена поднимется на +0.30% выше
// входа (это окупает круг комиссии), и смотрим, за сколько это произошло и
// произошло ли вообще за трое суток. Группируем по глубине падения от
// суточного максимума.
//
// Запуск:  node scripts/measure-recovery.js [дней]
// По умолчанию 12 дней по 15 монетам с наибольшим объёмом.
const fs = require('fs');
const path = require('path');

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = path.join(require('os').tmpdir(), 'recovery-candles.json');

const DAYS = Number(process.argv[2] || 12);
const NEED = 0.30;                 // возврат = вход + это, окупает комиссию
const WINDOW = 3 * 24 * 60;        // ждём возврата не дольше трёх суток
const STEP = 15;                   // точка входа каждые 15 минут

// Падение от максимума считается ЧЕСТНО: доля самого максимума, а не «на
// сколько цене надо вырасти обратно». Прежняя формула (hi/px-1) завышала
// глубину: её 10% это настоящие 9.1%.
const fallPct = (high, price) => (high - price) / high * 100;

async function candles(pair, fromMs, toMs) {
  const out = [];
  let cur = fromMs;
  while (cur < toMs) {
    const end = Math.min(toMs, cur + 299 * 60_000);
    const url = `${CB}/products/${pair}/candles?granularity=60` +
      `&start=${new Date(cur).toISOString()}&end=${new Date(end).toISOString()}`;
    try {
      const r = await fetch(url, H);
      if (r.ok) {
        const raw = await r.json();
        if (Array.isArray(raw)) {
          for (const c of raw) out.push({ t: Number(c[0]), lo: Number(c[1]), hi: Number(c[2]), cl: Number(c[4]) });
        }
      }
    } catch { }
    await sleep(240);
    cur = end;
  }
  const seen = new Set();
  return out.filter(c => c.t && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}

(async () => {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }

  const stats = await (await fetch(`${CB}/products`, H)).json();
  const usd = stats.filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled);
  const vols = [];
  for (const p of usd.slice(0, 120)) {
    try {
      const st = await (await fetch(`${CB}/products/${p.id}/stats`, H)).json();
      const v = Number(st.volume) * Number(st.last);
      if (v > 0) vols.push({ coin: p.base_currency, pair: p.id, v });
    } catch { }
    await sleep(120);
  }
  const coins = vols.sort((a, b) => b.v - a.v).slice(0, 15);
  console.log('монет: ' + coins.length + ', дней: ' + DAYS);

  const to = Date.now(), from = to - DAYS * 86400000;
  for (const { coin, pair } of coins) {
    if (cache[coin] && cache[coin].length > DAYS * 1200) continue;
    process.stdout.write('  качаю ' + coin + '… ');
    cache[coin] = await candles(pair, from, to);
    console.log(cache[coin].length + ' свечей');
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }

  const rows = [];
  for (const coin in cache) {
    const cs = cache[coin];
    if (cs.length < WINDOW + 1500) continue;
    for (let i = 1440; i < cs.length - WINDOW; i += STEP) {
      const px = cs[i].cl;
      if (!(px > 0)) continue;
      const hiDay = Math.max(...cs.slice(i - 1440, i + 1).map(c => c.hi));
      if (!(hiDay > 0)) continue;
      const fall = fallPct(hiDay, px);
      const tp = px * (1 + NEED / 100);
      let mins = null;
      for (let k = i + 1; k <= i + WINDOW; k++) {
        if (cs[k].hi >= tp) { mins = k - i; break; }
      }
      rows.push({ fall, mins });
    }
  }

  const pct = (a, f) => a.length ? a.filter(f).length / a.length * 100 : 0;
  console.log('\nточек входа: ' + rows.length + ', возврат = +' + NEED + '% выше входа, окно ' + (WINDOW / 1440) + ' сут\n');
  console.log('  падение от суточного максимума    n      за час   за 6ч   за 24ч   НЕ вернулось');
  const B = [[0, 1], [1, 3], [3, 6], [6, 10], [10, 1e9]];
  for (const [lo, hi] of B) {
    const g = rows.filter(r => r.fall >= lo && r.fall < hi);
    if (g.length < 50) { console.log('  ' + (lo + '–' + hi).padEnd(34) + 'мало (' + g.length + ')'); continue; }
    const label = hi > 1e8 ? ('более ' + lo + '%') : (lo + '–' + hi + '%');
    console.log('  ' + label.padEnd(34) + String(g.length).padStart(5) + '   ' +
      pct(g, r => r.mins != null && r.mins <= 60).toFixed(0).padStart(6) + '%  ' +
      pct(g, r => r.mins != null && r.mins <= 360).toFixed(0).padStart(5) + '%  ' +
      pct(g, r => r.mins != null && r.mins <= 1440).toFixed(0).padStart(6) + '%   ' +
      pct(g, r => r.mins == null).toFixed(1).padStart(11) + '%');
  }
  console.log('\nЭти числа зашиты в recoveryOdds() в server.js. Разошлись — значит');
  console.log('рынок сменился и таблицу пора обновлять вместе с датой замера.');
})();
