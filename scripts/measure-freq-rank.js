// Стоит ли сортировать таблицу по частоте самой монеты.
//
// Запуск: node scripts/measure-freq-rank.js
// Свечи берутся из кеша сверки: node scripts/recheck-recovery.js
//
// Панель теперь показывает число каждой монеты отдельно и ставит выше тех, у
// кого оно больше. Но выше по частоте касания — не то же самое, что лучше по
// деньгам: монета касается +0.30% чаще потому, что дёргается сильнее, а
// дёргается она в обе стороны.
//
// Проверяем честно и вне выборки: частоту считаем на ПЕРВОЙ половине
// периода, результат сделок меряем на ВТОРОЙ. Если высокочастотные монеты
// там окажутся хуже, сортировка показывает пальцем на худшее.
const fs = require('fs'), path = require('path'), os = require('os');
const cache = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'runup-5m.json'), 'utf8'));
const MAKER = 0.075, TAKER = 0.15, STOP = 3, GATE = 3, NEED = 0.30;
const MIN_A = 30, MIN_B = 15, MIN_COINS = 4;

function points(coin) {
  const ok = (cache[coin] || []).filter(c => Number.isFinite(c.t) && c.lo > 0 && c.hi >= c.lo &&
    c.cl >= c.lo && c.cl <= c.hi).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 288; i + 12 < ok.length; i += 12) {
    const t0 = ok[i].t, px = ok[i].cl;
    const day = ok.slice(i - 288, i + 1).filter(c => t0 - c.t <= 86400);
    if (day.length < 30 || (t0 - day[0].t) < 20 * 3600) continue;
    const hiD = Math.max(...day.map(c => c.hi));
    if (!(hiD > 0 && px > 0)) continue;
    if ((hiD - px) / hiD * 100 < GATE) continue;          // тот же гейт, что в панели
    const hour = ok.slice(i + 1, i + 13);
    if (hour.length !== 12 || hour.some((c, k) => c.t !== t0 + (k + 1) * 300)) continue;
    const hit = hour.some(c => c.hi >= px * (1 + NEED / 100));
    const net = {};
    for (const [name, h, target] of [['1ч/0.3%', 12, 0.3], ['4ч/1%', 48, 1]]) {
      const future = ok.slice(i + 1, i + 1 + h);
      if (future.length !== h || future.some((c, k) => c.t !== t0 + (k + 1) * 300)) { net[name] = null; continue; }
      const up = px * (1 + target / 100), dn = px * (1 - STOP / 100);
      let v = null;
      for (const c of future) {
        if (c.lo <= dn) { v = -STOP - 2 * TAKER; break; }
        if (c.hi >= up) { v = target - TAKER - MAKER; break; }
      }
      net[name] = v == null ? (future[future.length - 1].cl / px - 1) * 100 - 2 * TAKER : v;
    }
    out.push({ t: t0 * 1000, hit, net });
  }
  return out;
}

const all = {};
for (const coin in cache) { const p = points(coin); if (p.length) all[coin] = p; }
const times = Object.values(all).flat().map(r => r.t);
const T0 = Math.min(...times), T1 = Math.max(...times), MID = T0 + (T1 - T0) / 2;
const day = ms => new Date(ms).toISOString().slice(0, 10);
console.log('частота считается ' + day(T0) + '—' + day(MID) + ', сделки меряются ' + day(MID) + '—' + day(T1));

// Частота монеты на первой половине — ровно то, что панель теперь показывает
const freq = [];
for (const coin in all) {
  const a = all[coin].filter(r => r.t < MID);
  if (a.length < MIN_A) continue;
  const b = all[coin].filter(r => r.t >= MID);
  if (b.length < MIN_B) continue;
  freq.push({ coin, pct: a.filter(r => r.hit).length / a.length * 100, nA: a.length, rows: b });
}
freq.sort((x, y) => y.pct - x.pct);
console.log('монет с достаточной историей: ' + freq.length);
console.log('верх списка: ' + freq.slice(0, 5).map(x => x.coin + ' ' + x.pct.toFixed(0) + '%').join(', '));
console.log('низ списка:  ' + freq.slice(-5).map(x => x.coin + ' ' + x.pct.toFixed(0) + '%').join(', '));

function pool(group, mode) {
  const parts = group.map(x => {
    const v = x.rows.map(r => r.net[mode]).filter(n => n != null);
    return v.length >= MIN_B ? { m: v.reduce((s, n) => s + n, 0) / v.length, n: v.length } : null;
  }).filter(Boolean);
  if (parts.length < MIN_COINS) return null;
  const total = parts.reduce((s, x) => s + x.n, 0);
  const m = parts.reduce((s, x) => s + x.m * x.n, 0) / total;
  const se = Math.sqrt(parts.length / (parts.length - 1) *
    parts.reduce((s, x) => s + ((x.m - m) * x.n / total) ** 2, 0));
  return { m, se, n: total, coins: parts.length };
}

const k = Math.max(MIN_COINS, Math.floor(freq.length / 5));
for (const mode of ['1ч/0.3%', '4ч/1%']) {
  const top = pool(freq.slice(0, k), mode), bottom = pool(freq.slice(-k), mode), allc = pool(freq, mode);
  console.log('\n=== ' + mode + ' ===');
  const show = (name, c) => console.log('  ' + name.padEnd(28) +
    (c ? ((c.m >= 0 ? '+' : '') + c.m.toFixed(3) + '% ±' + c.se.toFixed(3) + '  сделок ' + c.n + ', монет ' + c.coins) : 'мало данных'));
  show('верхняя пятина по частоте', top);
  show('нижняя пятина по частоте', bottom);
  show('все монеты', allc);
  if (top && bottom) {
    const d = top.m - bottom.m, se = Math.sqrt(top.se ** 2 + bottom.se ** 2);
    console.log('  разница верх−низ: ' + (d >= 0 ? '+' : '') + d.toFixed(3) + ' ±' + se.toFixed(3) +
      (Math.abs(d) > 2 * se ? (d > 0 ? '   ВЫШЕ ЧАСТОТА ЛУЧШЕ' : '   ВЫШЕ ЧАСТОТА ХУЖЕ') : '   разницы нет'));
  }
}
