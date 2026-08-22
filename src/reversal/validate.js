/**
 * Финальная честная проверка: есть ли вообще направленное преимущество
 * в идее «покупать сильно упавшие монеты после подтверждения разворота».
 *
 *  1. Симметричный барьер ±3% — есть ли направленный перевес (безубыток = 50%)
 *  2. Устойчивость топ-комбинаций по трём отрезкам времени, а не двум
 *  3. Сравнение с контрольной группой: те же монеты, но БЕЗ просадки
 *  4. Реалистичный расчёт с комиссиями
 *
 * Запуск: node src/reversal/validate.js
 */
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'reversal-backtest.json'), 'utf8'));
const S = data.samples;
const FEE = 0.125; // % такером на сторону (как в настройках приложения)

// Барьерный тест с произвольными порогами по MFE/MAE недоступен точно,
// поэтому используем сохранённые mfe/mae как оценку достижимости уровней.
// mfe/mae — экстремумы за 3 дня, поэтому для симметричного теста
// пересчитываем «что было достижимо» консервативно: при обоих достигнутых → считаем проигрышем.
function symBarrier(rows, th) {
  let w = 0, l = 0, u = 0;
  for (const r of rows) {
    const up = r.fwd.mfe >= th, dn = r.fwd.mae <= -th;
    if (dn) l++;            // консервативно: стоп приоритетнее
    else if (up) w++;
    else u++;
  }
  return { n: rows.length, w, l, u, win: (w + l) ? Math.round(w / (w + l) * 100) : null };
}

function bar(rows) {
  const res = rows.filter(r => r.fwd.barrier != null);
  const w = res.filter(r => r.fwd.barrier === 1).length, l = res.length - w;
  return { n: rows.length, resolved: res.length, win: res.length ? Math.round(w / res.length * 100) : null, pf: l ? Math.round((w * 5) / (l * 3) * 100) / 100 : null };
}
const avg = (rows, k) => { const v = rows.map(r => r.fwd[k]).filter(x => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 100) / 100 : null; };

console.log('═'.repeat(92));
console.log('  1. СИММЕТРИЧНЫЙ БАРЬЕР — ОЦЕНКА СВЕРХУ ВНИЗ (безубыток = 50%)');
console.log('═'.repeat(92));
console.log('  ВНИМАНИЕ: считается по сохранённым экстремумам MFE/MAE, а не пошагово.');
console.log('  При среднем ходе ±8% за 3 дня оба порога почти всегда задеваются, и метод');
console.log('  консервативно засчитывает стоп → цифры ЗАНИЖЕНЫ. Опорным считать п.4');
console.log('  (барьер +5%/−3% считается честно, бар за баром).');
for (const th of [2, 3, 5]) {
  const b = symBarrier(S, th);
  console.log(`  ±${th}%:  вверх первым ${b.w} · вниз первым ${b.l} · ни туда ни сюда ${b.u}  →  ${b.win}% вверх  (нужно >50%)`);
}
console.log('\n  То же для лучших комбинаций:');
const COMBOS = {
  'Breakout + EMA20': s => s.bo && s.aboveEma,
  'EMA20 + RSI-восст.': s => s.aboveEma && s.rsiRecovering,
  'Higher Low + EMA20': s => s.hl && s.aboveEma,
  'Bullish divergence': s => s.div,
};
for (const [n, f] of Object.entries(COMBOS)) {
  const sub = S.filter(f);
  const b = symBarrier(sub, 3);
  console.log(`  ${n.padEnd(22)} n=${String(sub.length).padStart(4)}  ±3%: ${b.win}% вверх  (${b.w}W/${b.l}L)`);
}

// ── 2. Три отрезка вместо двух ──
console.log('\n' + '═'.repeat(92));
console.log('  2. УСТОЙЧИВОСТЬ ПО ТРЁМ ОТРЕЗКАМ ВРЕМЕНИ (по 50 дней)');
console.log('═'.repeat(92));
const ts = S.map(s => s.t).sort((a, b) => a - b);
const c1 = ts[Math.floor(ts.length / 3)], c2 = ts[Math.floor(ts.length * 2 / 3)];
const segs = [
  ['отрезок 1', S.filter(s => s.t < c1)],
  ['отрезок 2', S.filter(s => s.t >= c1 && s.t < c2)],
  ['отрезок 3', S.filter(s => s.t >= c2)],
];
segs.forEach(([n, arr]) => {
  const b = bar(arr);
  const tt = arr.map(s => s.t).sort((a, b2) => a - b2); // сэмплы лежат по монетам, не по времени
  console.log(`  ${n}: ${new Date(tt[0] * 1000).toISOString().slice(0, 10)} → ${new Date(tt[tt.length - 1] * 1000).toISOString().slice(0, 10)} · n=${b.n} · база win ${b.win}%`);
});
console.log('\n  КОМБИНАЦИЯ                отр.1          отр.2          отр.3        ИТОГ');
console.log('  ' + '─'.repeat(88));
for (const [name, fn] of Object.entries(COMBOS)) {
  const cells = segs.map(([, arr]) => {
    const b = bar(arr.filter(fn)), base = bar(arr);
    if (b.resolved < 15) return `н/д(${b.n})`.padEnd(14);
    const lift = b.win - base.win;
    return `${b.win}% ${(lift >= 0 ? '+' : '') + lift}пп (${b.n})`.padEnd(14);
  });
  const good = segs.filter(([, arr]) => {
    const b = bar(arr.filter(fn)), base = bar(arr);
    return b.resolved >= 15 && b.win > base.win;
  }).length;
  const tested = segs.filter(([, arr]) => bar(arr.filter(fn)).resolved >= 15).length;
  console.log(`  ${name.padEnd(24)} ${cells.join(' ')} ${good}/${tested} отрезков в плюс`);
}

// ── 3. Контрольная группа: те же монеты БЕЗ просадки ──
console.log('\n' + '═'.repeat(92));
console.log('  3. КОНТРОЛЬ: важна ли вообще просадка 30d? (сравнение внутри пула)');
console.log('═'.repeat(92));
for (const [lo, hi, lbl] of [[-1000, -50, 'глубже −50%'], [-50, -40, '−50…−40%'], [-40, -32, '−40…−32%'], [-32, -25, '−32…−25%']]) {
  const sub = S.filter(s => s.pct30d > lo && s.pct30d <= hi);
  const b = bar(sub);
  if (b.resolved < 20) { console.log(`  ${lbl.padEnd(14)} мало данных (${b.n})`); continue; }
  console.log(`  ${lbl.padEnd(14)} n=${String(b.n).padStart(4)} · win ${String(b.win).padStart(3)}% · PF ${String(b.pf).padStart(5)} · 3d ${avg(sub, '3d')}% · 7d ${avg(sub, '7d')}%`);
}

// ── 4. Реальная экономика с комиссиями ──
console.log('\n' + '═'.repeat(92));
console.log('  4. ЭКОНОМИКА С КОМИССИЯМИ (вход+выход такером = ' + (FEE * 2) + '%)');
console.log('═'.repeat(92));
const netTrade = (winRate, tp = 5, sl = 3) => {
  const cost = FEE * 2;
  return Math.round(((winRate / 100) * (tp - cost) - (1 - winRate / 100) * (sl + cost)) * 1000) / 1000;
};
const baseB = bar(S);
console.log(`  База (просто купить упавшую):        win ${baseB.win}% → ожидание ${netTrade(baseB.win) >= 0 ? '+' : ''}${netTrade(baseB.win)}% на сделку`);
for (const [n, f] of Object.entries(COMBOS)) {
  const b = bar(S.filter(f));
  if (b.resolved < 25) continue;
  const e = netTrade(b.win);
  console.log(`  ${n.padEnd(36)} win ${b.win}% → ожидание ${e >= 0 ? '+' : ''}${e}% на сделку  ${e > 0 ? '✅' : '❌'}`);
}
console.log(`\n  Порог безубыточности с комиссиями: нужно ${Math.ceil((3 + FEE * 2) / (5 - FEE * 2 + 3 + FEE * 2) * 100)}% побед при TP+5%/SL−3%`);

// ── 5. Что реально работает: удержание без стопа ──
console.log('\n' + '═'.repeat(92));
console.log('  5. А ЕСЛИ БЕЗ СТОПА? Средняя доходность удержания N дней');
console.log('═'.repeat(92));
console.log('  ГРУППА                          6h       24h       3d        7d');
console.log('  ' + '─'.repeat(88));
const show = (lbl, rows) => {
  if (rows.length < 25) return;
  console.log(`  ${lbl.padEnd(30)} ${String(avg(rows, '6h')).padStart(6)}%  ${String(avg(rows, '24h')).padStart(6)}%  ${String(avg(rows, '3d')).padStart(6)}%  ${String(avg(rows, '7d')).padStart(6)}%`);
};
show('ВСЯ БАЗА (упавшие ≥25%)', S);
for (const [n, f] of Object.entries(COMBOS)) show(n, S.filter(f));
show('RSI < 30 («дёшево»)', S.filter(s => s.rsi != null && s.rsi < 30));
show('Volume spike ≥2x', S.filter(s => s.volSpike >= 2));
show('Дно было ≥3 дня назад + EMA20', S.filter(s => s.aboveEma && s.hl));
