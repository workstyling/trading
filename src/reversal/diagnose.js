/**
 * Диагностика воронки: на каком именно фильтре отсекаются монеты
 * + прогон с ослабленными порогами, чтобы увидеть картину рынка целиком.
 * Запуск: node src/reversal/diagnose.js
 */
const rev = require('./index');
const fs = require('fs');
const path = require('path');

const KEY = process.env.CRYPTORANK_API_KEY || 'ef01b6459dbfbf7bad96be0c01fbdb393fd5d2bb9c3db186a2bc94d40371';

async function getMcapMap() {
  const url = new URL('https://api.cryptorank.io/v2/currencies');
  url.searchParams.append('limit', '1000');
  url.searchParams.append('sortBy', 'rank');
  url.searchParams.append('sortDirection', 'ASC');
  const r = await fetch(url.toString(), { headers: { 'X-Api-Key': KEY } });
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

const fmtUsd = n => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(0) + 'K' : '$' + n.toFixed(0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mcap = await getMcapMap();
  const products = await (await fetch('https://api.exchange.coinbase.com/products')).json();
  const pairs = products
    .filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
    .map(p => p.base_currency)
    .filter(s => !rev.STABLECOINS.has(s));

  const all = [];   // все монеты Coinbase с дневными данными и известной капой
  console.log(`Собираю дневные данные по ${pairs.length} парам...`);
  for (let i = 0; i < pairs.length; i += 2) {
    const batch = pairs.slice(i, i + 2);
    await Promise.all(batch.map(async sym => {
      const d = await rev.fetchDaily(sym);
      if (!d) return;
      const mc = mcap[sym]?.mc || 0;
      const crPx = mcap[sym]?.px || 0;
      const collision = crPx > 0 && (d.price / crPx > 2.5 || crPx / d.price > 2.5);
      all.push({ coin: sym, mcap: mc, collision, volToMcap: mc > 0 ? d.vol24 / mc : 0, ...d });
    }));
    if (i % 60 === 0) process.stdout.write(`${i} `);
    await sleep(200);
  }
  console.log(`\nСобрано: ${all.length}\n`);

  // ── Воронка по одному фильтру за раз ──
  const known = all.filter(c => c.mcap > 0 && !c.collision);
  const F = rev.FILTERS;
  const step = (label, arr) => { console.log(`  ${label.padEnd(46)} ${String(arr.length).padStart(4)}`); return arr; };

  console.log('═'.repeat(58));
  console.log('  ВОРОНКА ФИЛЬТРОВ (каждый шаг применяется поверх прошлого)');
  console.log('═'.repeat(58));
  step('Все USD-пары Coinbase (без стейблов)', all);
  let s = step('  с известной капитализацией', known);
  s = step(`  mcap ${fmtUsd(F.mcapMin)}–${fmtUsd(F.mcapMax)}`, s.filter(c => c.mcap >= F.mcapMin && c.mcap <= F.mcapMax));
  const afterMcap = s;
  s = step(`  30d ≤ ${F.drop30dMax}%`, s.filter(c => c.pct30d <= F.drop30dMax));
  const afterDrop = s;
  s = step(`  vol24 ≥ ${fmtUsd(F.vol24Min)}`, s.filter(c => c.vol24 >= F.vol24Min));
  s = step(`  vol/mcap ≥ ${(F.volToMcapMin * 100).toFixed(0)}%`, s.filter(c => c.volToMcap >= F.volToMcapMin));

  // ── Что отсекает каждый фильтр по отдельности (после mcap) ──
  console.log('\n' + '═'.repeat(58));
  console.log('  КАЖДЫЙ ФИЛЬТР ПО ОТДЕЛЬНОСТИ (из ' + afterMcap.length + ' по mcap)');
  console.log('═'.repeat(58));
  console.log(`  проходят 30d ≤ −30%:      ${afterMcap.filter(c => c.pct30d <= -30).length}`);
  console.log(`  проходят vol24 ≥ $500K:   ${afterMcap.filter(c => c.vol24 >= 500e3).length}`);
  console.log(`  проходят vol/mcap ≥ 2%:   ${afterMcap.filter(c => c.volToMcap >= 0.02).length}`);
  console.log(`  из упавших ≥30% — с vol24 ≥ $500K:  ${afterDrop.filter(c => c.vol24 >= 500e3).length}`);
  console.log(`  из упавших ≥30% — с vol/mcap ≥ 2%:  ${afterDrop.filter(c => c.volToMcap >= 0.02).length}`);

  // ── Распределение падений ──
  console.log('\n' + '═'.repeat(58));
  console.log('  РАСПРЕДЕЛЕНИЕ 30D-ПАДЕНИЙ (mcap $20M–$5B, ' + afterMcap.length + ' монет)');
  console.log('═'.repeat(58));
  const buckets = [[-100, -50], [-50, -40], [-40, -30], [-30, -25], [-25, -20], [-20, -10], [-10, 0], [0, 1000]];
  for (const [lo, hi] of buckets) {
    const a = afterMcap.filter(c => c.pct30d > lo && c.pct30d <= hi);
    const lbl = hi === 1000 ? 'рост' : `${lo}%…${hi}%`;
    console.log(`  ${lbl.padEnd(14)} ${String(a.length).padStart(3)}  ${'█'.repeat(Math.round(a.length / 2))}`);
  }

  // ── Топ упавших, независимо от объёмных фильтров ──
  console.log('\n' + '═'.repeat(58));
  console.log('  ТОП-20 УПАВШИХ ЗА 30 ДНЕЙ (mcap $20M–$5B) — что их отсекает');
  console.log('═'.repeat(58));
  const top = [...afterMcap].sort((a, b) => a.pct30d - b.pct30d).slice(0, 20);
  console.log('  COIN      30D%    VOL24     VOL/MC   SPIKE   ДНО   ОТ ДНА   БЛОКЕР');
  for (const c of top) {
    const blockers = [];
    if (c.vol24 < 500e3) blockers.push('объём');
    if (c.volToMcap < 0.02) blockers.push('vol/mc');
    console.log(`  ${c.coin.padEnd(8)} ${c.pct30d.toFixed(0).padStart(5)}% ${fmtUsd(c.vol24).padStart(8)} ${(c.volToMcap * 100).toFixed(1).padStart(6)}% ${c.volSpike.toFixed(1).padStart(6)}x ${String(c.daysFromLow).padStart(4)}д ${('+' + c.fromLowPct.toFixed(0) + '%').padStart(7)}   ${blockers.join('+') || '✅ проходит'}`);
  }

  fs.writeFileSync(path.join(__dirname, '..', '..', 'reversal-diagnose.json'), JSON.stringify({ all, at: Date.now() }, null, 2));
  console.log('\nСырые данные: reversal-diagnose.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
