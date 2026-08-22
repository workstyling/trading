/**
 * CLI: полный прогон Reversal Score по всем Coinbase USD-парам.
 * Запуск: node src/reversal/run-scan.js
 */
const rev = require('./index');

const CRYPTORANK_API_KEY = process.env.CRYPTORANK_API_KEY || 'ef01b6459dbfbf7bad96be0c01fbdb393fd5d2bb9c3db186a2bc94d40371';

async function getMcapMap() {
  const url = new URL('https://api.cryptorank.io/v2/currencies');
  url.searchParams.append('limit', '1000');
  url.searchParams.append('sortBy', 'rank');
  url.searchParams.append('sortDirection', 'ASC');
  const r = await fetch(url.toString(), { headers: { 'X-Api-Key': CRYPTORANK_API_KEY } });
  if (!r.ok) throw new Error('cryptorank ' + r.status);
  const data = await r.json();
  const map = {};
  (data.data || []).forEach(c => {
    const sym = (c.symbol || '').toUpperCase();
    const mc = parseFloat(c.marketCap ?? c.values?.USD?.marketCap ?? 0);
    const px = parseFloat(c.price ?? c.values?.USD?.price ?? 0);
    if (sym && mc && !map[sym]) map[sym] = { mc, px };
  });
  return map;
}

const fmtUsd = n => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n.toFixed(0);
const fmtPx = p => p < 0.001 ? p.toFixed(8) : p < 1 ? p.toFixed(5) : p < 100 ? p.toFixed(3) : p.toFixed(2);

(async () => {
  const t0 = Date.now();
  console.log('Загружаю market cap из CryptoRank...');
  const mcap = await getMcapMap();
  console.log(`  ${Object.keys(mcap).length} монет с капитализацией\n`);

  let lastStage = '';
  const out = await rev.scan(mcap, (stage, done, total) => {
    if (stage !== lastStage) { lastStage = stage; process.stdout.write(`\n[${stage}] `); }
    if (done % 20 === 0 || done === total) process.stdout.write(`${done}/${total} `);
  });

  console.log('\n\n' + '═'.repeat(78));
  console.log('  30D CRASH → REVERSAL SCORE — результаты прогона');
  console.log('═'.repeat(78));
  const f = out.filters;
  console.log(`Фильтр: mcap ${fmtUsd(f.mcapMin)}–${fmtUsd(f.mcapMax)} · vol24 ≥ ${fmtUsd(f.vol24Min)} · vol/mc ≥ ${(f.volToMcapMin * 100).toFixed(0)}% · 30d ≤ ${f.drop30dMax}%`);
  console.log(`Воронка: ${out.stats.pairs} USD-пар → ${out.stats.byMcap} по mcap → ${out.stats.dailyOk} с данными → ${out.stats.passedFilter} прошли фильтр`);
  if (out.btc) console.log(`BTC regime: $${out.btc.price.toFixed(0)} · ${out.btc.aboveEma20 ? 'ВЫШЕ' : 'НИЖЕ'} EMA20(4H) · 4h ${out.btc.pct4h >= 0 ? '+' : ''}${out.btc.pct4h}%`);
  console.log(`Время прогона: ${Math.round((Date.now() - t0) / 1000)}с\n`);

  if (!out.results.length) {
    console.log('Ни одна монета не прошла первичный фильтр.');
    return;
  }

  // Таблица
  const head = ['#', 'COIN', 'SCORE', 'OS', 'CONF', 'ВЕРДИКТ', '30D%', 'RSI4H', 'VOLx', 'DIV', 'HL', 'BO', 'MCAP', 'VOL24'];
  const rows = out.results.map((r, i) => [
    String(i + 1), r.coin, String(r.score), String(r.oversoldScore), String(r.confirmScore),
    r.verdict.replace(/[^\wА-Яа-яЁё ]/g, '').trim(),
    r.pct30d.toFixed(0) + '%',
    r.rsi4h != null ? String(r.rsi4h) : '—',
    r.volSpike.toFixed(1) + 'x',
    r.divergence?.found ? '✓' : '·',
    r.higherLow?.found ? '✓' : '·',
    r.breakout?.found ? '✓' : '·',
    fmtUsd(r.mcap), fmtUsd(r.vol24),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => [...r[i]].length)));
  const line = cells => cells.map((c, i) => c.padEnd(w[i])).join(' │ ');
  console.log(line(head));
  console.log(w.map(x => '─'.repeat(x)).join('─┼─'));
  rows.forEach(r => console.log(line(r)));

  // Детали по топ-5
  console.log('\n' + '═'.repeat(78));
  console.log('  ДЕТАЛИ ПО ТОП-5');
  console.log('═'.repeat(78));
  for (const r of out.results.slice(0, 5)) {
    console.log(`\n▸ ${r.coin}-USD  —  ${r.score}/100  ${r.verdict}`);
    console.log(`  Цена $${fmtPx(r.price)} · mcap ${fmtUsd(r.mcap)} · vol24 ${fmtUsd(r.vol24)} (${(r.volToMcap * 100).toFixed(1)}% от капы, spike ${r.volSpike.toFixed(2)}x)`);
    console.log(`  30d ${r.pct30d.toFixed(1)}%${r.pct60d != null ? ` · 60d ${r.pct60d.toFixed(1)}%` : ''} · дно ${r.daysFromLow}д назад, от дна +${r.fromLowPct.toFixed(1)}%`);
    console.log(`  RSI 4H ${r.rsi4h} (минимум за 7д: ${r.rsiMin7d}) · EMA20 4H: ${r.aboveEma20_4h ? 'цена ВЫШЕ' : 'цена ниже'}`);
    if (r.divergence?.found) console.log(`  ✓ Bullish divergence: цена ${fmtPx(r.divergence.p1)} → ${fmtPx(r.divergence.p2)} (ниже), RSI ${r.divergence.r1} → ${r.divergence.r2} (выше), ${r.divergence.barsAgo} свечей назад`);
    if (r.higherLow?.found) console.log(`  ✓ Higher Low: дно ${fmtPx(r.higherLow.bottom)} → HL ${fmtPx(r.higherLow.hlPrice)} (+${r.higherLow.liftPct}%), дно ${r.higherLow.bottomBarsAgo} свечей назад`);
    if (r.breakout?.found) console.log(`  ✓ Breakout: пробит lower high ${fmtPx(r.breakout.level)} (+${r.breakout.distPct}%)`);
    if (r.capitulation?.found) console.log(`  ✓ Капитуляционная свеча: объём ${r.capitulation.volX}x, ${r.capitulation.barsAgo} свечей назад`);
    console.log('  Баллы: ' + r.parts.map(p => `${p.label} ${p.pts}/${p.max}`).join(' · '));
  }

  // Сводка по вердиктам
  console.log('\n' + '═'.repeat(78));
  const byVerdict = {};
  out.results.forEach(r => { byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1; });
  console.log('  Распределение: ' + Object.entries(byVerdict).map(([k, v]) => `${k} — ${v}`).join(' · '));
  console.log('═'.repeat(78));

  require('fs').writeFileSync(
    require('path').join(__dirname, '..', '..', 'reversal-scan-result.json'),
    JSON.stringify(out, null, 2)
  );
  console.log('\nПолный результат сохранён в reversal-scan-result.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
