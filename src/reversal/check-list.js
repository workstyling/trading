/**
 * Прогон конкретных монет через откалиброванную (по бэктесту) логику.
 * Запуск: node src/reversal/check-list.js KAITO ALLO KTA ...
 */
const rev = require('./index');

// ── Гейт входа по результатам бэктеста ──
// Работает только связка: окно просадки −32…−50% + цена выше EMA20 4H + RSI из ямы.
function gate(m) {
  const checks = [
    { k: 'Окно просадки −32…−50%', ok: m.pct30d <= -32 && m.pct30d >= -50, val: m.pct30d.toFixed(1) + '%' },
    { k: 'Цена выше EMA20 (4H)', ok: !!m.aboveEma20_4h, val: m.aboveEma20_4h ? 'да' : 'нет' },
    { k: 'RSI вышел из перепроданности', ok: !!m.rsiRecovering, val: `${m.rsi4h} (мин 7д ${m.rsiMin7d})` },
    { k: 'Ликвидность vol24 ≥ $500K', ok: m.vol24 >= 500e3, val: '$' + (m.vol24 / 1e3).toFixed(0) + 'K' },
  ];
  return { pass: checks.every(c => c.ok), checks };
}

const fmtUsd = n => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : '$' + (n / 1e3).toFixed(0) + 'K';

(async () => {
  const coins = process.argv.slice(2).map(s => s.toUpperCase());
  if (!coins.length) { console.log('Укажи монеты: node src/reversal/check-list.js KAITO ALLO'); return; }
  const btc = await rev.getBtcRegime();
  console.log(`BTC: $${btc.price.toFixed(0)} · ${btc.aboveEma20 ? 'выше' : 'ниже'} EMA20(4H) · 4h ${btc.pct4h >= 0 ? '+' : ''}${btc.pct4h}%\n`);
  console.log('═'.repeat(78));

  const passed = [];
  for (const coin of coins) {
    const d = await rev.fetchDaily(coin);
    if (!d) { console.log(`${coin}: нет дневных данных`); continue; }
    const s = await rev.fetchReversalSignals(coin);
    if (!s) { console.log(`${coin}: нет часовых данных`); continue; }
    const rsiRecovering = s.rsiMin7d != null && s.rsi4h != null && s.rsiMin7d < 30 && s.rsi4h > s.rsiMin7d + 4;
    const m = { ...d, ...s, rsiRecovering };
    const g = gate(m);
    if (g.pass) passed.push(coin);

    const bucket = d.pct30d <= -50 ? '⚠ глубже −50% (худшая группа: win 32%)'
      : d.pct30d <= -40 ? '✓ −50…−40% (оптимум: win 44%)'
      : d.pct30d <= -32 ? '✓ −40…−32% (хорошая: win 41%)'
      : '⚠ мельче −32% (слабая: win 35%)';

    console.log(`\n${g.pass ? '🟢 ПРОХОДИТ' : '🔴 НЕ ПРОХОДИТ'}  ${coin}-USD  $${d.price < 1 ? d.price.toFixed(5) : d.price.toFixed(2)}`);
    console.log(`  30d ${d.pct30d.toFixed(1)}% · ${bucket}`);
    console.log(`  vol24 ${fmtUsd(d.vol24)} (spike ${d.volSpike.toFixed(2)}x) · дно ${d.daysFromLow}д назад, от дна +${d.fromLowPct.toFixed(1)}%`);
    for (const c of g.checks) console.log(`    ${c.ok ? '✓' : '✗'} ${c.k.padEnd(32)} ${c.val}`);
    const extra = [];
    if (s.divergence?.found) extra.push('divergence (слабый бонус)');
    if (s.higherLow?.found) extra.push('higher low');
    if (s.breakout?.found) extra.push('breakout');
    if (extra.length) console.log(`    · дополнительно: ${extra.join(', ')}`);
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n' + '═'.repeat(78));
  console.log(passed.length
    ? `ПРОХОДЯТ ГЕЙТ: ${passed.join(', ')}`
    : 'Ни одна монета не проходит гейт входа — сидим на руках.');
  console.log('═'.repeat(78));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
