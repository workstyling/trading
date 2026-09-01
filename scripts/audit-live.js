// Сквозная проверка боевой системы: сходятся ли числа сами с собой и с
// независимым расчётом. Каждая строка — утверждение, которое либо верно,
// либо нет; без «выглядит нормально».
const BASE = 'http://103.90.162.77:3847';
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'audit/1.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, checks = 0;

function ok(cond, name, detail) {
  checks++;
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}
async function j(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, H); if (r.ok) return await r.json(); } catch { }
    await sleep(500);
  }
  return null;
}
function ema(v, p) {
  if (v.length < p) return null;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}

(async () => {
  console.log('=== СКАНЕР ===');
  const scan = await j(BASE + '/api/scalp-scan');
  ok(!!scan && scan.success, 'эндпоинт отвечает');
  if (!scan) return;
  ok(scan.total > 50, 'просканировано монет', scan.scanned + '/' + scan.total);
  ok(scan.scanned === scan.total, 'проход завершён полностью');
  ok(scan.agoSec != null && scan.agoSec < 300, 'скан свежий', scan.agoSec + 'с назад');
  ok(!!scan.regime, 'режим посчитан', scan.regime ? scan.regime.distPct + '%' : '—');

  const res = scan.results || [];
  ok(res.length > 0, 'есть результаты', res.length + ' строк');
  // балл должен быть согласован с числом пройденных условий
  const badScore = res.filter(r => r.pass && r.score < 86);
  ok(badScore.length === 0, 'прошедшие гейт имеют балл 86+', badScore.length ? badScore.map(x => x.coin + '=' + x.score).join(',') : '');
  const badPass = res.filter(r => r.pass && r.passed !== r.checks.length);
  ok(badPass.length === 0, 'pass=true только при всех условиях');
  const capped = res.filter(r => !scan.regime.above && r.score > 60);
  ok(!scan.regime.above ? capped.length === 0 : true, 'при закрытом режиме балл не выше 60');
  const sorted = res.every((r, i) => i === 0 || res[i - 1].score >= r.score);
  ok(sorted, 'результаты отсортированы по баллу');
  const dup = new Set(res.map(r => r.coin)).size !== res.length;
  ok(!dup, 'нет дублей монет');
  const tagOk = res.every(r => r.pass ? (r.tagOwn || r.tag) === 'ВХОД' : true);
  ok(tagOk, 'вердикт согласован с pass');

  console.log('\n=== РЕЖИМ, НЕЗАВИСИМЫЙ ПЕРЕСЧЁТ ===');
  const bd = await j(CB + '/products/BTC-USD/candles?granularity=3600');
  const bc = bd.filter(x => x[4] > 0).map(x => ({ t: x[0], c: x[4] })).sort((a, b) => a.t - b.t);
  const be = ema(bc.map(x => x.c), 20);
  const mine = (bc[bc.length - 1].c / be - 1) * 100;
  ok(Math.abs(mine - scan.regime.distPct) < 0.3, 'запас BTC сходится',
    'панель ' + scan.regime.distPct + '% / расчёт ' + mine.toFixed(2) + '%');
  ok((mine > 0) === scan.regime.above, 'сторона EMA20 определена верно');

  console.log('\n=== ЛАБОРАТОРИЯ ===');
  const lab = await j(BASE + '/api/lab');
  ok(!!lab && lab.success, 'эндпоинт отвечает');
  if (lab) {
    ok(lab.enabled, 'включена');
    ok(lab.fingerprint && lab.fingerprint.length === 12, 'отпечаток гейта', lab.fingerprint);
    const open = lab.open || [];
    ok(open.every(t => t.entry > 0), 'у всех открытых есть цена входа');
    ok(open.every(t => t.mfe == null || t.mae == null || t.mfe >= t.mae), 'пик не ниже дна');
    const closed = lab.closed || [];
    ok(closed.every(t => t.closedAt > t.openedAt), 'закрытие позже открытия');
    ok(closed.every(t => ['TP', 'SL', 'TIME'].includes(t.why)), 'у всех закрытых есть причина');
    // pnl должен соответствовать причине
    const tpBad = closed.filter(t => t.why === 'TP' && t.pnlPct <= 0);
    ok(tpBad.length === 0, 'сделки по цели прибыльные', tpBad.map(t => t.coin).join(','));
    const slBad = closed.filter(t => t.why === 'SL' && t.pnlPct > 0);
    ok(slBad.length === 0, 'сделки по стопу убыточные', slBad.map(t => t.coin).join(','));
    // closed[] теперь только текущая когорта, прошлые версии гейта лежат в
    // archivedClosed[]. closedCount считает обе, поэтому сравнивать его с
    // длиной closed[] больше нельзя — проверяем настоящий инвариант.
    ok(lab.closedCount === (lab.currentClosedCount || 0) + (lab.staleClosedCount || 0),
      'счётчик закрытых = текущие + архивные',
      lab.closedCount + ' против ' + (lab.currentClosedCount || 0) + '+' + (lab.staleClosedCount || 0));
    ok(closed.length === Math.min(40, lab.currentClosedCount || 0),
      'closed[] отдаёт текущую когорту', closed.length + ' против ' + (lab.currentClosedCount || 0));
    const b = lab.brief || '';
    ok(b.length > 300, 'задание формируется', b.length + ' символов');
    ok(!/[а-яА-Я]/.test(b), 'задание без кириллицы');
    ok(!b.includes('+0.199%'), 'старый эталон убран');
    // Статический эталон из задания убран намеренно: сравнивать живые
    // сделки с числом, посчитанным на другой версии гейта, нельзя.
    // Теперь контракт другой — задание обязано назвать историческую
    // проверку именно того отпечатка, по которому набирались сделки.
    // Формулировка менялась дважды; проверяем суть, а не точную фразу:
    // задание обязано привязать прогон к отпечатку либо честно сказать, что
    // подходящего прогона нет.
    ok(/validation for this fingerprint|No sufficient historical validation/i.test(b),
      'задание называет историческую проверку своего отпечатка');
    ok(!/Backtest over \d+ days/.test(b), 'статического эталона в задании нет');
    ok((b.match(/�/g) || []).length === 0, 'нет битых символов');
  }

  console.log('\n=== АЛЕРТЫ ===');
  ok(typeof scan.watch === 'boolean', 'состояние одноразового отдаётся', String(scan.watch));
  ok(typeof scan.watchLoop === 'boolean', 'состояние непрерывного отдаётся', String(scan.watchLoop));
  const st = await j(BASE + '/get-settings');
  const tg = st && st.settings;
  // Токен наружу больше не отдаётся — он лежал в HTML на виду. Спрашиваем
  // сервер о факте настройки, а не о самом значении.
  ok(tg && tg.telegramToken === undefined, 'токен Telegram наружу не отдаётся');
  ok(!!(tg && tg.telegramConfigured), 'Telegram настроен');
  ok(!(scan.watchLoop || scan.watch) || !!(tg && tg.telegramConfigured), 'алерт не включён без Telegram');

  console.log('\n=== PAPER / ЦЕЛИ ===');
  const paper = await j(BASE + '/api/paper');
  ok(!!paper && paper.success, 'эндпоинт отвечает');
  if (paper && tg) {
    ok(paper.targetPct > 0 && paper.targetPct <= 20, 'цель в разумных пределах', paper.targetPct + '%');
    ok(paper.slPct >= 0 && paper.slPct <= 20, 'стоп в разумных пределах', paper.slPct + '%');
    ok(tg.sellMarkup === 1.38, 'Sell Markup не тронут экспериментом', tg.sellMarkup + '%');
    ok(paper.targetPct !== tg.sellMarkup, 'цель отвязана от Sell Markup');
  }

  console.log('\n' + '='.repeat(60));
  console.log(fails === 0 ? 'ВСЕ ' + checks + ' ПРОВЕРОК ПРОШЛИ' : fails + ' ИЗ ' + checks + ' ПРОВЕРОК УПАЛИ');
})().catch(e => console.error('ошибка аудита', e.message));
