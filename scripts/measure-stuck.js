// Зависший хвост: если позиция ушла в минус, чем это кончается.
//
// В открытых позициях сейчас −$1022, и три монеты висят двадцатый день:
// −63%, −57%, −29%. Решение «держать или резать» принимается ощущением.
// Здесь оно переводится в число.
//
// Вопрос ставится так, как он стоит в жизни: «я УЖЕ в минусе на столько-то —
// что дальше». Поэтому отсчёт идёт не от покупки, а от МОМЕНТА, когда просадка
// впервые достигла порога. От него и меряется, вернётся ли цена к безубытку и
// за сколько.
//
// Безубыток — не цена покупки, а цена покупки плюс круг комиссии (рынок 0.15%
// + лимитка 0.075%): продать по цене входа значит остаться в минусе.
//
// Свечи часовые за 200 суток: вопрос про дни и недели, минутная точность тут
// не нужна, а истории нужно много.
const fs = require('fs'), path = require('path');
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CACHE = path.join(require('os').tmpdir(), 'stuck-1h.json');
const DAYS = 200, HOUR = 3600;
const BREAK_EVEN = 1.00225;          // круг комиссии: 0.15% + 0.075%
const GATE = 3;                      // падение от суточного максимума, как в панели
const STEP = 6;                      // точка входа раз в 6 часов
const DD = [10, 20, 30, 45, 60];     // пороги просадки, %
const WAIT = [1, 3, 7, 14, 30];      // сроки ожидания, суток
const MAXW = Math.max(...WAIT);

let pace = 300;
async function candles(pair, fromMs, toMs) {
  const out = [];
  let cur = fromMs;
  while (cur < toMs) {
    const end = Math.min(toMs, cur + 299 * HOUR * 1000);
    for (let a = 0; a < 4; a++) {
      try {
        const r = await fetch(`${CB}/products/${pair}/candles?granularity=3600` +
          `&start=${new Date(cur).toISOString()}&end=${new Date(end).toISOString()}`, H);
        if (r.ok) {
          const raw = await r.json();
          if (Array.isArray(raw)) for (const c of raw) out.push({ t: +c[0], lo: +c[1], hi: +c[2], cl: +c[4] });
          pace = Math.max(Math.round(pace * 0.97), 300);
          break;
        }
      } catch { }
      pace = Math.min(Math.round(pace * 1.6), 2500);
      await sleep([1000, 3000, 8000, 0][a]);
    }
    await sleep(pace);
    cur = end;
  }
  const seen = new Set();
  return out.filter(c => c.t && !seen.has(c.t) && seen.add(c.t)).sort((a, b) => a.t - b.t);
}

(async () => {
  const { STABLE } = require(path.join('C:', 'Programming', 'trading', 'src', 'scalp', 'scanner'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { }

  const prods = await (await fetch(`${CB}/products`, H)).json();
  const stats = await (await fetch(`${CB}/products/stats`, H)).json();
  const vols = [];
  for (const p of prods) {
    if (p.quote_currency !== 'USD' || p.status !== 'online' || p.trading_disabled) continue;
    if (STABLE.has(p.base_currency)) continue;
    const st = stats[p.id];
    if (!st || !st.stats_24hour) continue;
    const v = Number(st.stats_24hour.volume) * Number(st.stats_24hour.last);
    if (v >= 2e6) vols.push({ coin: p.base_currency, pair: p.id, v });
  }
  const basket = vols.sort((a, b) => b.v - a.v).slice(0, 60);
  console.log('корзина ' + basket.length + ' монет, история ' + DAYS + ' суток (часовые свечи)');

  const to = Date.now(), from = to - DAYS * 86400000;
  let k = 0;
  for (const { coin, pair } of basket) {
    k++;
    if (cache[coin] && cache[coin].length > DAYS * 20) continue;
    process.stdout.write('\r  качаю ' + coin + ' (' + k + '/' + basket.length + ')      ');
    const got = await candles(pair, from, to);
    if (got.length > DAYS * 15) {
      cache[coin] = got;
      try { fs.writeFileSync(CACHE, JSON.stringify(cache)); } catch { }
    }
  }
  console.log('');

  // ── замер ────────────────────────────────────────────────────────────────
  // Для каждой точки входа: когда просадка впервые пробила порог и вернулась
  // ли цена к безубытку за N суток ПОСЛЕ этого момента.
  const res = DD.map(() => WAIT.map(() => ({ n: 0, back: 0, days: [] })));
  const seen = DD.map(() => ({ coins: new Set(), n: 0 }));
  let entries = 0, coinsUsed = 0;

  for (const { coin } of basket) {
    const cs = cache[coin];
    if (!cs || cs.length < 24 * 40) continue;
    coinsUsed++;
    for (let i = 24; i < cs.length; i += STEP) {
      const px = cs[i].cl;
      if (!(px > 0)) continue;
      // Тот же вход, что у панели: падение от суточного максимума 3%+
      const t0 = cs[i].t;
      const wd = cs.slice(Math.max(0, i - 30), i + 1).filter(c => t0 - c.t <= 24 * HOUR);
      if (wd.length < 12) continue;
      const hd = Math.max(...wd.map(c => c.hi));
      if (!(hd > 0) || (hd - px) / hd * 100 < GATE) continue;
      entries++;

      const be = px * BREAK_EVEN;
      // Идём вперёд один раз: отмечаем моменты пробоя каждого порога и все
      // моменты возврата к безубытку.
      const hitAt = new Array(DD.length).fill(null);
      let backAt = null;
      for (let j = i + 1; j < cs.length; j++) {
        const hrs = (cs[j].t - t0) / HOUR;
        for (let d = 0; d < DD.length; d++) {
          if (hitAt[d] == null && (cs[j].lo / px - 1) * 100 <= -DD[d]) hitAt[d] = { j, hrs };
        }
        if (backAt == null && hitAt[0] != null && j > hitAt[0].j && cs[j].hi >= be) { backAt = { j, hrs }; }
        if (hitAt[DD.length - 1] != null && backAt != null) break;
      }

      for (let d = 0; d < DD.length; d++) {
        const h = hitAt[d];
        if (!h) continue;
        seen[d].coins.add(coin); seen[d].n++;
        // Возврат считается ПОСЛЕ пробоя этого порога
        let back = null;
        for (let j = h.j + 1; j < cs.length; j++) {
          const days = (cs[j].t - cs[h.j].t) / 86400;
          if (days > MAXW) break;
          if (cs[j].hi >= be) { back = days; break; }
        }
        // Хвост данных: если после пробоя осталось меньше срока, случай в этот
        // срок не засчитывается вовсе — иначе «не вернулось» было бы враньём.
        const left = (cs[cs.length - 1].t - cs[h.j].t) / 86400;
        for (let w = 0; w < WAIT.length; w++) {
          if (left < WAIT[w] && (back == null || back > WAIT[w])) continue;
          res[d][w].n++;
          if (back != null && back <= WAIT[w]) { res[d][w].back++; res[d][w].days.push(back); }
        }
      }
    }
  }

  const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log('\nмонет ' + coinsUsed + ', точек входа ' + entries.toLocaleString('ru-RU') +
    '; безубыток = цена входа +0.225% (круг комиссии)');
  console.log('\n  просадка   случаев   вернулись к безубытку за');
  console.log('                        ' + WAIT.map(w => (w + ' сут').padStart(10)).join(''));
  for (let d = 0; d < DD.length; d++) {
    if (seen[d].n < 100) { console.log('  −' + DD[d] + '%'.padEnd(9) + 'мало (' + seen[d].n + ')'); continue; }
    let line = '  −' + String(DD[d] + '%').padEnd(9) + String(seen[d].n).padStart(7) + '   ';
    for (let w = 0; w < WAIT.length; w++) {
      const r = res[d][w];
      line += r.n < 50 ? 'мало'.padStart(10) : (Math.round(r.back / r.n * 100) + '%').padStart(10);
    }
    console.log(line + '    (' + seen[d].coins.size + ' монет)');
  }
  console.log('\n  сколько ждали те, кто вернулся (медиана, суток):');
  for (let d = 0; d < DD.length; d++) {
    const all = res[d][WAIT.length - 1];
    if (!all || all.days.length < 20) continue;
    console.log('  −' + String(DD[d] + '%').padEnd(9) + (med(all.days) || 0).toFixed(1) + ' сут' +
      '   (из вернувшихся за ' + MAXW + ' суток, ' + all.days.length + ' случаев)');
  }
})();
