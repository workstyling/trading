// Сторож на класс ошибки, которую синтаксическая проверка не ловит.
//
// Я перенёс проверку с десктопа в мобильную вёрстку, не сверив имя
// переменной: там она avgBuy, а не avgBuyPrice. Синтаксис остался чистым,
// а при отрисовке вылетал ReferenceError — и экран ордеров навсегда
// застревал на «Loading orders...». Ни один текстовый тест этого не видел.
//
// Здесь собираются имена, объявленные внутри блока отрисовки монеты, и
// сверяются с теми, что в нём используются.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };

const BLOCKS = [
  // BROKEN — путь к нарочно сломанной копии: так проверяется, что сторож
  // вообще способен поймать ошибку. Раньше здесь стоял путь с одной машины.
  ['mobile/index.html', (process.env.BROKEN || 'public/mobile/index.html'),
    '        let totalFilled = 0, totalUSD = 0', "setLiveHtmlM(document.getElementById('monitorList'), html)"],
  ['index.html', 'public/index.html',
    '        let totalFilled = 0, totalUSD = 0', '      // Only update if content changed'],
];

// Имена, ради которых всё и затевалось: они появились недавно и легко
// разъезжаются между вёрстками.
const WATCH = ['avgBuy', 'avgBuyPrice', 'totalFilled', 'totalUSD', 'positionClosed', 'restUsd',
  '_ordFilled', '_sellNow', '_sellCost', '_partial', '_st', 'exactSize', 'totalFilledStr'];

for (const [label, path, from, to] of BLOCKS) {
  console.log('\n' + label);
  const s = fs.readFileSync(path, 'utf8');
  const a = s.indexOf(from), b = s.indexOf(to, a);
  ok(a > 0 && b > a, 'блок отрисовки монеты найден');
  if (a < 0 || b < 0) continue;
  const block = s.slice(a, b);

  const declared = new Set();
  // Берём объявление ЦЕЛИКОМ до точки с запятой: `let a = 0, b = 0` иначе
  // даёт только первое имя, и проверка сама подняла ложную тревогу.
  for (const m of block.matchAll(/\b(?:const|let|var)\s+([^;]*);/g)) {
    let depth = 0, cur = '';
    const parts = [];
    for (const ch of m[1]) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    for (const part of parts) {
      const n = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) declared.add(n[1]);
    }
  }

  // Деструктуризация и параметры стрелок сюда не попадают — на них и не
  // смотрим: список WATCH перечисляет ровно те имена, что объявляются обычно.

  for (const name of WATCH) {
    const used = new RegExp('\\b' + name.replace('$', '\\$') + '\\b').test(block);
    if (!used) continue;
    ok(declared.has(name), 'имя ' + name + ' объявлено в том же блоке',
      declared.has(name) ? '' : 'используется, но не объявлено — при отрисовке будет ReferenceError');
  }
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
