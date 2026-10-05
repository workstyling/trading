// Разгон за месяц — пометка риска, которого рейтинг отката не видит.
//
// Рейтинг меряет сутки. Монета, выросшая за две недели в разы, выглядит в нём
// обычным часовым откатом, а риск вернуться к уровню до разгона нигде не
// показан. Пометка его показывает, но ничего не разрешает и не запрещает.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const { pumpFromDaily } = require('../src/recovery/pump');
const R = require('../public/js/recovery-journal');

// Свечи новыми вперёд, как отдаёт Coinbase: [time, low, high, open, close, volume]
const day = 86400, t0 = 1759000000;
const series = (lows, highs) => lows.map((lo, i) => [t0 + i * day, lo, highs[i], lo, highs[i], 1]).reverse();

// Разгон: 30 дней, база ~63 в начале, пик 372 на 21-й день, сейчас 250
const lows = [], highs = [];
for (let i = 0; i < 30; i++) {
  const v = i < 12 ? 63 + i : i < 21 ? 75 + (i - 11) * 33 : 300 - (i - 21) * 6;
  lows.push(v * 0.97); highs.push(i === 20 ? 372 : v * 1.03);
}
const p = pumpFromDaily(series(lows, highs), 250);
ok(p && p.pumped, 'рост в разы за месяц помечен', JSON.stringify(p));
ok(p && p.runup >= 5, 'кратность роста от базы до пика', p && p.runup);
ok(p && p.toBasePct < -70 && p.toBasePct > -80, 'до уровня до разгона больше −70%', p && p.toBasePct);
ok(p && p.givenBackPct > 30 && p.givenBackPct < 50, 'доля отданного роста', p && p.givenBackPct);
ok(p && p.peakDaysAgo === 9, 'пик — девять дней назад', p && p.peakDaysAgo);

// Спокойная монета: ±5% за месяц — пометки нет
const calm = pumpFromDaily(series(Array(30).fill(97), Array(30).fill(103)), 100);
ok(calm && !calm.pumped, 'спокойная монета без пометки', JSON.stringify(calm));

// Мало истории и мусор — не «спокойно», а «неизвестно»
ok(pumpFromDaily(series(Array(5).fill(97), Array(5).fill(103)), 100) === null, 'меньше десяти дней — неизвестно');
ok(pumpFromDaily(null, 100) === null && pumpFromDaily(series(lows, highs), 0) === null, 'нет свечей или цены — неизвестно');

// Падение после пика ниже базы: разгон был, но цена уже под базой — пометка снята
const under = pumpFromDaily(series(lows, highs), 50);
ok(under && !under.pumped && under.givenBackPct === 100, 'цена ниже базы — пометки нет, отдано 100%');

// Экран: пометка и подсказка из общего файла обеих вёрсток
const mark = R.recoveryPumpMark({ pump: p });
ok(/разгон ×\d/.test(mark), 'пометка «разгон ×N» в строке', mark.slice(0, 80));
ok(R.recoveryPumpMark({ pump: calm }) === '' && R.recoveryPumpMark({}) === '', 'без разгона и без данных — пусто');
ok(/не посчитан/.test(R.recoveryPumpNote({})), 'неизвестный разгон назван неизвестным, а не спокойным');
ok(/не проверялась/.test(R.recoveryPumpNote({ pump: p })), 'подсказка не выдаёт пометку за замер');

// Обе вёрстки рисуют пометку и подсказку
for (const f of ['public/index.html', 'public/mobile/index.html']) {
  const s = fs.readFileSync(f, 'utf8');
  ok(s.includes('recoveryPumpMark(x)') && s.includes('recoveryPumpNote(x)'), f + ': пометка и подсказка на месте');
}
// Порядок: внутри одного статуса строка без разгона выше помеченной, даже
// если у помеченной процент больше; статус и измеренность старше разгона.
{
  const now = Date.now();
  const scan = { at: now, serverNow: now, recoveryMeasuredAt: '2026-09-09', entryNet: { buyCells: [] } };
  const order = (row, hour) => R.recoveryOrder(row, scan, { tier: 1, label: 'наблюдать' }, { hour }, now);
  const clean = { coin: 'A', price: 1, inListMin: 5 }, hot = { coin: 'B', price: 1, inListMin: 5, pump: p };
  ok(order(clean, 72) > order(hot, 89.7), 'без разгона выше помеченной с большим процентом');
  ok(order(hot, 89.7) > order({ ...clean }, null), 'измеренная помеченная выше неизмеренной чистой: прочерк не плюс');
  ok(order(hot, 80) > order({ ...hot, coin: 'C' }, 75), 'среди помеченных — по проценту');
}
// Пометка не влезает в разрешение покупки: verdict и рамка её не читают
const src = fs.readFileSync('public/js/recovery-journal.js', 'utf8');
const verdictBody = src.slice(src.indexOf('function recoveryVerdict'), src.indexOf('function', src.indexOf('function recoveryVerdict') + 10));
ok(!/pump/.test(verdictBody), 'решение о покупке пометку не читает');

console.log(bad ? '\n' + bad + ' ПЛОХО' : '\nвсё хорошо');
process.exitCode = bad ? 1 : 0;
