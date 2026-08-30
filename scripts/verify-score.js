// Пересчёт балла по формуле из calcScalpScore, независимо от сервера.
// Сравниваем с тем, что реально отдаётся, для каждой монеты скана.
const BASE = 'http://103.90.162.77:3847';
const H = { headers: { 'User-Agent': 'verify/1.0' } };

function recompute(r, regimeAbove) {
  const num = v => parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  const get = k => (r.checks.find(x => x.k.includes(k)) || {});
  const rangePos = r.rangePos;
  const rsiRecover = get('RSI').ok;
  const aboveE9 = get('EMA9').ok;
  const vol24 = r.vol24 || 0;
  const range4 = num(get('Диапазон').v);
  const runUp = num(get('пампа').v);
  const liquid = vol24 >= 500e3;
  const spread = r.spreadPct;

  let sc = 0;
  if (rangePos < 0.25) sc += 25; else if (rangePos < 0.4) sc += 10; else if (rangePos > 0.9) sc -= 5;
  if (rsiRecover) sc += 25;
  else if (r.rsi != null && r.rsi < 30) sc += 5;
  if (aboveE9) sc += 25;
  if (vol24 >= 2e6) sc += 15; else if (vol24 >= 1e6) sc += 13; else if (vol24 >= 500e3) sc += 11; else if (vol24 >= 250e3) sc += 5;
  // e9overE21 и volX сервер наружу не отдаёт — это единственные слагаемые,
  // которые нельзя восстановить; каждое даёт +5. Считаем диапазон.
  const unknownMin = 0, unknownMax = 10;

  const fromHi = num((r.checks.find(x => x.k.includes('вершиной')) || {}).v);
  if (!isNaN(fromHi) && fromHi < -10) sc -= 35;
  if (range4 != null && !isNaN(range4) && range4 >= 8) sc -= 12;
  if (runUp != null && !isNaN(runUp) && runUp > 15) sc -= 15;
  // Спред — жёсткое условие: неизвестный спред это НЕ проход. Но потолок 44
  // за неизвестный спред применяется только к тому, кому он реально мешает
  // войти, то есть когда все прочие условия монеты выполнены. Иначе весь
  // список схлопывался бы в один балл: сканер запрашивает стакан лишь у
  // кандидатов, у остальных спред просто не измерен.
  const spreadKnown = Number.isFinite(spread) && spread >= 0;
  const wide = spreadKnown && spread > 0.4;
  const missing = !spreadKnown;
  if (wide) sc -= 15;

  // Условия самой монеты — без двух проверок режима, их добавляет сканер
  const own = r.checks.filter(c => c.k.indexOf('BTC') === -1 && c.k.indexOf('Неделя') === -1);
  const allOk = own.every(c => c.ok);
  const otherOk = (spreadKnown && !wide) ? allOk : own.filter(c => c.ok).length === own.length - 1;
  const clamp = (v) => {
    let x = v;
    if (!liquid) x = Math.min(x, 39);
    if (wide || (missing && otherOk)) x = Math.min(x, 44);
    if (!allOk) x = Math.min(x, 74);
    x = Math.max(0, Math.min(100, Math.round(x)));
    if (!regimeAbove) x = Math.max(0, Math.round(x * 0.6));
    return x;
  };
  return { lo: clamp(sc + unknownMin), hi: clamp(sc + unknownMax) };
}

(async () => {
  const r = await fetch(BASE + '/api/scalp-scan', H);
  const scan = await r.json();
  const above = scan.regime.above && scan.regime.ret7 > 0;   // режим = час И неделя
  console.log('Режим:', above ? 'открыт' : 'закрыт', '(' + scan.regime.distPct + '%)');
  console.log('Проверяем', Math.min(scan.results.length, 20), 'монет\n');
  console.log('МОНЕТА    СЕРВЕР   МОЙ ДИАПАЗОН   ГЕЙТ   ВЕРДИКТ');
  let bad = 0, checked = 0;
  for (const x of scan.results.slice(0, 20)) {
    const { lo, hi } = recompute(x, above);
    const ok = x.score >= lo && x.score <= hi;
    checked++;
    if (!ok) bad++;
    console.log('  ' + x.coin.padEnd(9) + String(x.score).padStart(4) + '   ' +
      (lo === hi ? String(lo) : lo + '-' + hi).padStart(9) + '     ' +
      (x.passed + '/' + x.checks.length).padStart(4) + '   ' +
      (x.tagOwn || x.tag).padEnd(14) + (ok ? '' : '  <-- РАСХОЖДЕНИЕ'));
  }
  console.log('\nДиапазон, а не одно число, потому что два слагаемых по +5');
  console.log('(EMA9 над EMA21 и всплеск объёма) наружу не отдаются.');
  console.log('\n' + (bad === 0 ? 'ВСЕ ' + checked + ' БАЛЛОВ СХОДЯТСЯ' : bad + ' из ' + checked + ' РАСХОДЯТСЯ'));

  // инварианты шкалы
  console.log('\n=== ИНВАРИАНТЫ ШКАЛЫ ===');
  const all = scan.results;
  const gap = all.filter(x => x.score > 74 && x.score < 86 && above);
  console.log('  значений в мёртвой зоне 75-85:', gap.length, gap.length === 0 ? '(верно)' : '(ОШИБКА)');
  const entries = all.filter(x => x.pass);
  console.log('  вход при балле ниже 86:', entries.filter(x => x.score < 86).length, '(должно быть 0)');
  const notEntry = all.filter(x => !x.pass && x.score >= 86);
  console.log('  балл 86+ без входа:', notEntry.length, '(должно быть 0)');
  if (!above) {
    console.log('  при закрытом режиме выше 60:', all.filter(x => x.score > 60).length, '(должно быть 0)');
  }
})().catch(e => console.error('ошибка', e.message));
