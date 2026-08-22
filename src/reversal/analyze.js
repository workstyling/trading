/**
 * Разбор сэмплов бэктеста: проверка устойчивости сигналов и пересборка весов
 * по ФАКТИЧЕСКИМ данным, а не по интуиции.
 *
 *  1. Out-of-sample: делим историю пополам по времени — держится ли edge?
 *  2. Комбинации подтверждающих сигналов
 *  3. Score v2 на измеренных весах + его монотонность
 *  4. Устойчивость по монетам (не одна ли монета делает весь результат)
 *
 * Запуск: node src/reversal/analyze.js
 */
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'reversal-backtest.json'), 'utf8'));
const S = data.samples;
const { TP, SL } = data.cfg;

function bar(rows) {
  const res = rows.filter(r => r.fwd.barrier != null);
  const w = res.filter(r => r.fwd.barrier === 1).length, l = res.length - w;
  return {
    n: rows.length, resolved: res.length,
    win: res.length ? Math.round(w / res.length * 100) : null,
    pf: l ? Math.round((w * TP) / (l * SL) * 100) / 100 : null,
    a3: rows.length ? Math.round(rows.reduce((a, r) => a + (r.fwd['3d'] ?? 0), 0) / rows.length * 100) / 100 : 0,
    a7: rows.length ? Math.round(rows.reduce((a, r) => a + (r.fwd['7d'] ?? 0), 0) / rows.length * 100) / 100 : 0,
  };
}

const BASE = bar(S);
const BREAKEVEN = Math.round(SL / (TP + SL) * 100);
console.log('═'.repeat(92));
console.log(`  ИСХОДНЫЕ ДАННЫЕ: ${S.length} сэмплов, ${new Set(S.map(s => s.coin)).size} монет, ${data.cfg.DAYS} дней`);
console.log(`  База: win ${BASE.win}% · PF ${BASE.pf}   |   БЕЗУБЫТОК при TP+${TP * 100}%/SL−${SL * 100}% = ${BREAKEVEN}% побед`);
console.log('═'.repeat(92));

// ── 1. Out-of-sample по времени ──
const times = S.map(s => s.t).sort((a, b) => a - b);
const mid = times[Math.floor(times.length / 2)];
const H1 = S.filter(s => s.t < mid), H2 = S.filter(s => s.t >= mid);
console.log(`\n  ПЕРИОД 1: ${new Date(mid * 1000).toISOString().slice(0, 10)} и раньше (n=${H1.length}) · ПЕРИОД 2: позже (n=${H2.length})`);

const SIG = {
  'RSI < 30': s => s.rsi != null && s.rsi < 30,
  'RSI выходит из ямы': s => s.rsiRecovering,
  'Volume spike ≥2x': s => s.volSpike >= 2,
  'Капитуляция': s => s.cap,
  'Bullish divergence': s => s.div,
  'Higher Low': s => s.hl,
  'Breakout': s => s.bo,
  'Выше EMA20 4H': s => s.aboveEma,
};

console.log('\n' + '═'.repeat(92));
console.log('  ПРОВЕРКА УСТОЙЧИВОСТИ: держится ли сигнал в ОБОИХ половинах истории?');
console.log('═'.repeat(92));
console.log('  СИГНАЛ                      ВСЁ (lift)      ПЕРИОД 1        ПЕРИОД 2      ВЕРДИКТ');
console.log('  ' + '─'.repeat(88));
const b1 = bar(H1), b2 = bar(H2);
const stable = {};
for (const [name, fn] of Object.entries(SIG)) {
  const all = bar(S.filter(fn)), p1 = bar(H1.filter(fn)), p2 = bar(H2.filter(fn));
  const lAll = all.win != null ? all.win - BASE.win : null;
  const l1 = p1.resolved >= 25 ? p1.win - b1.win : null;
  const l2 = p2.resolved >= 25 ? p2.win - b2.win : null;
  const sgn = v => v == null ? ' н/д ' : (v >= 0 ? '+' : '') + v + 'пп';
  let verdict;
  if (l1 == null || l2 == null) verdict = 'мало данных';
  else if (l1 > 0 && l2 > 0) verdict = '✅ УСТОЙЧИВ';
  else if (l1 < 0 && l2 < 0) verdict = '❌ вредит';
  else verdict = '⚠️ неустойчив';
  stable[name] = { lAll, l1, l2, verdict, n: all.n };
  console.log(`  ${name.padEnd(26)} ${(sgn(lAll) + ` (n=${all.n})`).padEnd(15)} ${(sgn(l1) + ` (n=${p1.n})`).padEnd(15)} ${(sgn(l2) + ` (n=${p2.n})`).padEnd(14)} ${verdict}`);
}

// ── 2. Комбинации ──
console.log('\n' + '═'.repeat(92));
console.log('  КОМБИНАЦИИ ПОДТВЕРЖДАЮЩИХ СИГНАЛОВ (минимум 25 разрешённых сэмплов)');
console.log('═'.repeat(92));
const COMBO = {
  'Breakout ТОЛЬКО': s => s.bo,
  'Breakout + EMA20': s => s.bo && s.aboveEma,
  'Breakout + HL': s => s.bo && s.hl,
  'Breakout + HL + EMA20': s => s.bo && s.hl && s.aboveEma,
  'Breakout + RSI-восстановление': s => s.bo && s.rsiRecovering,
  'EMA20 + HL + RSI-восст.': s => s.aboveEma && s.hl && s.rsiRecovering,
  'EMA20 + RSI-восстановление': s => s.aboveEma && s.rsiRecovering,
  'DIV + Breakout': s => s.div && s.bo,
  'DIV + EMA20': s => s.div && s.aboveEma,
  'BO+HL+EMA, БЕЗ vol-спайка': s => s.bo && s.hl && s.aboveEma && s.volSpike < 2,
  'Не глубже −40% + BO + EMA': s => s.pct30d > -40 && s.bo && s.aboveEma,
  'Глубже −40% + BO + EMA': s => s.pct30d <= -40 && s.bo && s.aboveEma,
};
console.log('  КОМБИНАЦИЯ                        N    WIN%    LIFT     PF      3d      7d');
console.log('  ' + '─'.repeat(88));
for (const [name, fn] of Object.entries(COMBO)) {
  const b = bar(S.filter(fn));
  if (b.resolved < 25) { console.log(`  ${name.padEnd(32)} ${String(b.n).padStart(4)}   — мало (${b.resolved})`); continue; }
  const lift = b.win - BASE.win;
  console.log(`  ${name.padEnd(32)} ${String(b.n).padStart(4)}   ${String(b.win).padStart(3)}%   ${((lift >= 0 ? '+' : '') + lift + 'пп').padStart(6)}   ${String(b.pf).padStart(5)}  ${((b.a3 >= 0 ? '+' : '') + b.a3 + '%').padStart(7)} ${((b.a7 >= 0 ? '+' : '') + b.a7 + '%').padStart(7)}`);
}

// ── 3. Score v2 на измеренных весах ──
// Веса пропорциональны измеренному lift: то, что не работает, получает 0.
function scoreV2(s) {
  let v = 0;
  if (s.bo) v += 35;                       // единственный сильный и устойчивый сигнал
  if (s.aboveEma) v += 25;                 // подтверждение тренда, большой сэмпл
  if (s.hl) v += 12;                       // слабый плюс, но не вредит
  if (s.rsiRecovering) v += 10;            // выход RSI из ямы (не сам факт RSI<30!)
  if (s.div) v += 8;                       // почти шум, минимальный вес
  if (s.volSpike >= 3) v += 5;             // только экстремальный спайк
  if (s.rsi != null && s.rsi < 30) v -= 8; // ШТРАФ: «дёшево» ≠ «развернётся»
  if (s.pct30d <= -50) v -= 5;             // сверхглубокая просадка ухудшает исход
  return Math.max(0, Math.min(100, v));
}
console.log('\n' + '═'.repeat(92));
console.log('  SCORE v2 (веса из измеренного lift) — монотонность');
console.log('═'.repeat(92));
console.log('  SCORE v2      N    WIN%    LIFT     PF      3d      7d');
console.log('  ' + '─'.repeat(88));
const withV2 = S.map(s => ({ ...s, v2: scoreV2(s) }));
for (const [lo, hi] of [[0, 15], [15, 30], [30, 45], [45, 60], [60, 75], [75, 101]]) {
  const sub = withV2.filter(s => s.v2 >= lo && s.v2 < hi);
  const b = bar(sub);
  if (b.resolved < 20) { console.log(`  ${(lo + '–' + hi).padEnd(12)} ${String(b.n).padStart(4)}   — мало (${b.resolved})`); continue; }
  const lift = b.win - BASE.win;
  console.log(`  ${(lo + '–' + hi).padEnd(12)} ${String(b.n).padStart(4)}   ${String(b.win).padStart(3)}%   ${((lift >= 0 ? '+' : '') + lift + 'пп').padStart(6)}   ${String(b.pf).padStart(5)}  ${((b.a3 >= 0 ? '+' : '') + b.a3 + '%').padStart(7)} ${((b.a7 >= 0 ? '+' : '') + b.a7 + '%').padStart(7)}`);
}

// v2 out-of-sample
console.log('\n  Проверка Score v2 ≥60 на двух половинах истории:');
for (const [lbl, set, bs] of [['Период 1', H1, b1], ['Период 2', H2, b2]]) {
  const sub = set.map(s => ({ ...s, v2: scoreV2(s) })).filter(s => s.v2 >= 60);
  const b = bar(sub);
  console.log(`    ${lbl}: n=${b.n} (разрешилось ${b.resolved}) · win ${b.win}% vs база ${bs.win}% → ${b.win != null ? ((b.win - bs.win >= 0 ? '+' : '') + (b.win - bs.win) + 'пп') : 'н/д'} · PF ${b.pf}`);
}

// ── 4. Устойчивость по монетам ──
console.log('\n' + '═'.repeat(92));
console.log('  НЕ ОДНА ЛИ МОНЕТА ДЕЛАЕТ ВЕСЬ РЕЗУЛЬТАТ? (сигнал Breakout+EMA20)');
console.log('═'.repeat(92));
const winners = withV2.filter(s => s.bo && s.aboveEma);
const byCoin = {};
winners.forEach(s => {
  const a = byCoin[s.coin] || (byCoin[s.coin] = { n: 0, w: 0, l: 0 });
  a.n++;
  if (s.fwd.barrier === 1) a.w++; else if (s.fwd.barrier === 0) a.l++;
});
const coinRows = Object.entries(byCoin).filter(([, a]) => a.w + a.l >= 2).sort((x, y) => y[1].n - x[1].n);
const coinsWithEdge = coinRows.filter(([, a]) => a.w / (a.w + a.l) > BREAKEVEN / 100).length;
console.log(`  Монет с ≥2 разрешёнными сигналами: ${coinRows.length} · из них прибыльных: ${coinsWithEdge} (${Math.round(coinsWithEdge / coinRows.length * 100)}%)`);
console.log('  Топ по количеству сигналов: ' + coinRows.slice(0, 12).map(([c, a]) => `${c} ${a.w}/${a.w + a.l}`).join(' · '));
// вклад лучшей монеты
const best = coinRows.slice().sort((x, y) => (y[1].w - y[1].l) - (x[1].w - x[1].l))[0];
if (best) {
  const without = winners.filter(s => s.coin !== best[0]);
  const b = bar(without);
  console.log(`  Без лучшей монеты (${best[0]}): win ${b.win}% (было ${bar(winners).win}%) → edge ${b.win > BASE.win ? 'сохраняется' : 'исчезает'}`);
}

// ── Итоговая рекомендация по фильтрам ──
console.log('\n' + '═'.repeat(92));
console.log('  ЧАСТОТА СИГНАЛА: сколько раз в месяц ждать вход');
console.log('═'.repeat(92));
const months = data.cfg.DAYS / 30;
const nCoins = new Set(S.map(s => s.coin)).size;
for (const [name, fn] of Object.entries({ 'Breakout + EMA20': s => s.bo && s.aboveEma, 'Score v2 ≥ 60': s => scoreV2(s) >= 60, 'Score v2 ≥ 45': s => scoreV2(s) >= 45 })) {
  const n = withV2.filter(fn).length;
  console.log(`  ${name.padEnd(22)} ${n} сигналов за ${data.cfg.DAYS}д по ${nCoins} монетам → ~${(n / months).toFixed(0)}/месяц по всему рынку`);
}
