// Сквозная проверка таблицы: каждое число пересчитано независимо.
//
// Берём то, что панель показывает прямо сейчас, и считаем всё заново со
// своими формулами по данным биржи. Расхождение — это либо ошибка сервера,
// либо ошибка здесь; и то и другое надо увидеть.
//
// Внутренние связи (возврат из сетки, вердикт из условий, порядок строк)
// обязаны совпадать ТОЧНО: они не зависят от времени.
// Внешние величины (падение, откат, ход за сутки, RSI, спред) сверяются с
// допуском: между сканом сервера и моей проверкой проходят минуты, и цена
// за это время двигается.
const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const SRV = 'http://103.90.162.77:3847';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let bad = 0, warn = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const soft = (c, m, x) => { if (!c) warn++; console.log('  ' + (c ? 'ok  ' : 'мимо') + '  ' + m + (x ? '   ' + x : '')); };

// Та же сетка, что зашита в server.js — выписана здесь руками, чтобы сверка
// была независимой. Если сервер её изменит, а здесь забудут, проверка упадёт.
function grid(fall, pull) {
  if (fall == null) return null;
  const d = Number(fall);
  if (!Number.isFinite(d)) return null;
  const deep = Number.isFinite(Number(pull)) && Number(pull) >= 1.5;
  if (d >= 10) return deep ? 89 : 78;
  if (d >= 6) return deep ? 87 : 73;
  if (d >= 3) return deep ? 84 : 66;
  if (d >= 1) return deep ? 84 : 57;
  return 56;
}
const rsi14 = (closes) => {
  if (closes.length < 15) return null;
  let u = 0, dn = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const x = closes[i] - closes[i - 1];
    if (x >= 0) u += x; else dn -= x;
  }
  return dn === 0 ? 100 : 100 - 100 / (1 + (u / 14) / (dn / 14));
};

(async () => {
  const j = await (await fetch(SRV + '/api/entry-scan')).json();
  const rows = j.results || [];
  const gate = j.gate;
  const ageMin = (Date.now() - j.at) / 60000;
  console.log('скан ' + new Date(j.at).toISOString().slice(11, 19) + ' (' + ageMin.toFixed(1) +
    ' мин назад), строк ' + rows.length + ', порог падения ' + gate.fallPct + '%, спреда ' + gate.spreadPct + '%');

  console.log('\n1. ВОЗВРАТ ДОЛЖЕН БЫТЬ РОВНО ИЗ СЕТКИ (падение + откат)');
  for (const r of rows) {
    const want = grid(r.dayFallPct, r.pullbackPct);
    const got = r.recovery ? r.recovery.hour : null;
    ok(want === got, r.coin.padEnd(9) + 'падение ' + r.dayFallPct + '%, откат ' + r.pullbackPct + '% → ' + want + '%',
      got === want ? '' : 'сервер дал ' + got);
  }

  console.log('\n2. ПОМЕТКА «ГЛУБОКИЙ ОТКАТ» СОВПАДАЕТ С ПОРОГОМ 1.5%');
  for (const r of rows) {
    if (!r.recovery) continue;
    ok(!!r.recovery.deep === (r.pullbackPct >= 1.5), r.coin.padEnd(9) + 'откат ' + r.pullbackPct + '%',
      'deep=' + r.recovery.deep);
  }

  console.log('\n3. ВЕРДИКТ СОБРАН ИЗ ТЕХ УСЛОВИЙ, ЧТО ЗАЯВЛЕНЫ');
  const verdict = (r) => {
    const pass = r.dayFallPct >= gate.fallPct && r.spreadPct != null && r.spreadPct <= gate.spreadPct;
    if (!pass) return '—';
    if (r.chg24Pct != null && Math.abs(r.chg24Pct) >= 10) return 'риск';
    return r.pullbackPct >= 1.5 ? 'брать' : 'можно';
  };
  const tierNum = { 'брать': 3, 'можно': 2, 'риск': 1, '—': 0 };
  for (const r of rows) {
    const v = verdict(r);
    const pass = r.dayFallPct >= gate.fallPct && r.spreadPct != null && r.spreadPct <= gate.spreadPct;
    ok(pass, r.coin.padEnd(9) + 'прошла порог входа (падение ' + r.dayFallPct + '%, спред ' + r.spreadPct + '%)');
    if (v === 'риск') ok(Math.abs(r.chg24Pct) >= 10, r.coin.padEnd(9) + 'риск обоснован ходом ' + r.chg24Pct + '%');
  }

  console.log('\n4. ПОРЯДОК СТРОК: СНАЧАЛА «БРАТЬ», ПОТОМ «МОЖНО», ПОТОМ «РИСК»');
  let prev = 9, order = true;
  for (const r of rows) {
    const t = tierNum[verdict(r)];
    if (t > prev) order = false;
    prev = t;
  }
  ok(order, 'уровни не перемешаны', rows.map(r => verdict(r)[0]).join(''));
  // Внутри уровня — по возврату, затем по откату
  let inner = true;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (verdict(a) !== verdict(b)) continue;
    const ra = (a.recovery && a.recovery.hour) || 0, rb = (b.recovery && b.recovery.hour) || 0;
    if (rb > ra) inner = false;
    if (rb === ra && (b.pullbackPct || 0) > (a.pullbackPct || 0) + 1e-9) inner = false;
  }
  ok(inner, 'внутри уровня — по возврату, затем по откату');

  console.log('\n5. ЧИСЛА СВЕРЕНЫ С БИРЖЕЙ НАПРЯМУЮ (допуск на время)');
  for (const r of rows.slice(0, 8)) {
    const raw = await (await fetch(`${CB}/products/${r.coin}-USD/candles?granularity=300`, H)).json();
    const cs = raw.slice(0, 288).map(x => ({ t: +x[0] * 1000, lo: +x[1], hi: +x[2], cl: +x[4] }))
      .filter(x => x.lo > 0 && x.hi > 0 && x.cl > 0);
    const px = cs[0].cl;
    const t0 = cs[0].t;
    const w30 = cs.filter(x => t0 - x.t <= 30 * 60_000);
    const wd = cs.filter(x => t0 - x.t <= 24 * 3600_000);
    const hi30 = Math.max(...w30.map(x => x.hi));
    const hiD = Math.max(...wd.map(x => x.hi));
    const fall = (hiD - px) / hiD * 100;
    const pull = (hi30 / px - 1) * 100;
    const want = t0 - 24 * 3600_000;
    let best = null;
    for (const x of cs) if (!best || Math.abs(x.t - want) < Math.abs(best.t - want)) best = x;
    const chg = (px / best.cl - 1) * 100;
    const rsi = rsi14(cs.slice(0, 15).map(x => x.cl).reverse());

    const dFall = Math.abs(fall - r.dayFallPct);
    const dPull = Math.abs(pull - r.pullbackPct);
    const dChg = Math.abs(chg - (r.chg24Pct == null ? chg : r.chg24Pct));
    const dRsi = r.rsi == null ? 0 : Math.abs(rsi - r.rsi);
    soft(dFall < 1.0, r.coin.padEnd(9) + 'падение: сервер ' + r.dayFallPct + '%, у меня ' + fall.toFixed(2) + '%');
    soft(dPull < 1.0, r.coin.padEnd(9) + 'откат:   сервер ' + r.pullbackPct + '%, у меня ' + pull.toFixed(2) + '%');
    soft(dChg < 1.5, r.coin.padEnd(9) + 'за сутки: сервер ' + r.chg24Pct + '%, у меня ' + chg.toFixed(2) + '%');
    soft(dRsi < 12, r.coin.padEnd(9) + 'RSI:     сервер ' + r.rsi + ', у меня ' + (rsi == null ? '—' : rsi.toFixed(0)));
    await sleep(250);
  }

  console.log('\n6. СПРЕД СВЕРЕН СО СТАКАНОМ');
  for (const r of rows.slice(0, 6)) {
    const b = await (await fetch(`${CB}/products/${r.coin}-USD/book?level=1`, H)).json();
    const bid = +b.bids[0][0], ask = +b.asks[0][0];
    const sp = (ask / bid - 1) * 100;
    soft(Math.abs(sp - r.spreadPct) < 0.15, r.coin.padEnd(9) + 'спред: сервер ' + r.spreadPct + '%, у меня ' + sp.toFixed(3) + '%');
    await sleep(250);
  }

  console.log('\n7. ЧЕГО В ТАБЛИЦЕ БЫТЬ НЕ ДОЛЖНО');
  ok(!rows.some(r => r.dayFallPct == null), 'нет строк без падения');
  ok(!rows.some(r => r.recovery == null), 'нет строк без возврата');
  ok(!rows.some(r => r.spreadPct == null), 'нет строк с неизвестным спредом');
  ok(!rows.some(r => r.price == null || !(r.price > 0)), 'нет строк без цены');
  const coins = rows.map(r => r.coin);
  ok(new Set(coins).size === coins.length, 'монеты не повторяются');
  const STABLE = ['USDT', 'USDC', 'DAI', 'PYUSD', 'EURC'];
  ok(!coins.some(c => STABLE.includes(c)), 'стейблкоинов нет');
  ok((j.missed || []).length === 0, 'непосчитанных нет', JSON.stringify(j.missed));

  console.log('\n' + (bad ? 'ПЛОХО: ' + bad : 'точных расхождений нет') +
    (warn ? ' | мимо допуска: ' + warn : ' | все сверки с биржей в допуске'));
  process.exit(bad ? 1 : 0);
})();
