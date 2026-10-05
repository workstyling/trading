// Падающий рынок — отдельный замер, отдельное разрешение.
//
// Вопрос «можно ли брать монеты, когда рынок падает» проверяется тем же
// прогоном по свечам, но только по входам на падающем рынке (BTC и медиана
// корзины за сутки ниже нуля; определение записано до прогона). Клетка из
// этого замера разрешает покупку, только пока скан видит тот же режим.
// Режим неизвестен — не разрешает ничего: отсутствие данных не разрешение.
const fs = require('fs');
const { recoveryBuyCell, recoveryRegimeLine } = require('../public/js/recovery-journal');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const now = Date.now();
const CELL = { lo: 3, deep: false, horizonH: 24, target: 3, netA: 0.31, seA: 0.1, netB: 0.28, seB: 0.09, n: 900 };
const base = { recoveryMeasuredAt: '2026-09-09', at: now, serverNow: now,
  entryNet: { from: '2026-09-10', to: '2026-10-05', panel: -0.25, panelSe: 0.01, control: -0.24, controlSe: 0.01,
    n: 1, controlN: 1, modes: 16, plusModes: 0, buyCells: [] },
  entryRegime: { down: { panel: -0.26, control: -0.28, buyCells: [CELL] }, up: { panel: -0.22, control: -0.22, buyCells: [] } } };
const row = { coin: 'FIL', price: 1, dayFallPct: 4, pullbackPct: 0.5, chg24Pct: -2, spreadPct: 0.1 };

console.log('\nКлетка падающего рынка');
{
  const down = recoveryBuyCell(row, { ...base, market: { regime: 'down' } });
  ok(down && down.regime === 'down' && down.horizonH === 24, 'рынок падает — клетка режима действует', JSON.stringify(down));
  ok(recoveryBuyCell(row, { ...base, market: { regime: 'up' } }) === null, 'рынок не падает — клетка падения не действует');
  ok(recoveryBuyCell(row, { ...base, market: { regime: null } }) === null, 'режим неизвестен — ничего не разрешено');
  ok(recoveryBuyCell(row, { ...base, market: null }) === null, 'сводки рынка нет — ничего не разрешено');
  ok(recoveryBuyCell(row, { ...base, market: { regime: 'sideways' } }) === null, 'непонятный режим — ничего не разрешено');
}

console.log('\nСтрока панели про падающий рынок');
{
  const none = { ...base, entryRegime: { ...base.entryRegime, down: { ...base.entryRegime.down, buyCells: [] } } };
  const line = recoveryRegimeLine({ ...none, market: { regime: 'down' } }).replace(/<[^>]+>/g, '');
  ok(/Падающий рынок/.test(line) && /падает/.test(line), 'названо, что рынок сейчас падает', line);
  ok(/не входить/.test(line), 'без разрешённых групп сказано прямо: на падении не входить');
  ok(/неизвестен/.test(recoveryRegimeLine({ ...none, market: null })), 'неизвестный режим назван неизвестным');
  ok(/разрешено групп: 1/.test(recoveryRegimeLine({ ...base, market: { regime: 'down' } })), 'разрешённая группа видна в строке');
  ok(recoveryRegimeLine({ ...base, entryRegime: null }) === '', 'без замера — строки нет');
}

console.log('\nСервер и замер согласованы');
{
  const src = fs.readFileSync('server.js', 'utf8');
  ok(/const ENTRY_REGIME = \{/.test(src) && /entryRegime: ENTRY_REGIME/.test(src), 'замер режима в коде и уходит в панель');
  ok(/btc\.chg24Pct < 0 && mid < 0 \? 'down' : 'up'/.test(src), 'живой режим считается тем же определением, что в замере');
  ok(/moved\.length >= ENTRY_REGIME_MIN_COINS/.test(src), 'мало монет — режим неизвестен');
  const script = fs.readFileSync('scripts/measure-net.js', 'utf8');
  ok(/b < 0 && median\(all\) < 0 \? 'down' : 'up'/.test(script), 'замер использует то же определение');
}

console.log(bad ? '\n' + bad + ' ПЛОХО' : '\nвсё хорошо');
process.exitCode = bad ? 1 : 0;
