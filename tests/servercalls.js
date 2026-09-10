// Сторож на класс ошибки, который я допустил дважды за час.
//
// Переношу код между файлами и не сверяю имя: сначала avgBuyPrice вместо
// avgBuy (уронило мобильный экран ордеров), потом getBalances вместо
// fetchAccountBalances. Синтаксис в обоих случаях чист, а падает на исполнении
// — то есть тогда, когда уже выложено.
//
// scopecheck.js закрывает вёрстку. Здесь то же самое для server.js: берём
// функции, которые я трогаю, и требуем, чтобы каждое имя, которое они зовут,
// было в файле объявлено.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');

// Встроенные и глобальные — не наши, проверять нечего.
const BUILTIN = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'await', 'new', 'do', 'else',
  'Number', 'String', 'Boolean', 'Math', 'Date', 'JSON', 'Array', 'Object', 'Set', 'Map', 'Promise',
  'parseInt', 'parseFloat', 'isNaN', 'console', 'require', 'fetch', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'Error', 'RegExp', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
  'async', 'try', 'of', 'in', 'delete', 'void', 'yield',
]);

// Комментарии и строки выбрасываем: `// RSI(14) по свечам` выглядит как
// вызов RSI(), а текст в кавычках — как что угодно.
function stripNoise(code) {
  let out = '', i = 0;
  while (i < code.length) {
    const two = code.slice(i, i + 2);
    if (two === '//') { const j = code.indexOf('\n', i); i = j < 0 ? code.length : j; continue; }
    if (two === '/*') { const j = code.indexOf('*/', i + 2); i = j < 0 ? code.length : j + 2; continue; }
    const ch = code[i];
    if (ch === '\'' || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== ch) { if (code[j] === '\\') j++; j++; }
      out += ' '; i = j + 1; continue;
    }
    out += ch; i++;
  }
  return out;
}

// Функции, за которыми смотрим. Список растёт вместе с тем, что я правлю.
const WATCH = [
  'reconcileBeWatches', 'autoBeWatch', 'autoFavorite', 'positionAgainstWallet',
  'positionFromOrders', 'partialValue', 'checkFilledOrders', 'entryPaperSettle',
  'entryPaperOpen', 'runEntryScan', 'entrySignals', 'recoveryOdds', 'runupOdds',
  'microScalpTerms', 'beOptOutSet',
];

const bodyOf = (name) => {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  // Идём по скобкам от начала тела: срез «до \n}» рвётся на вложенных функциях
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
};

const declared = (name) =>
  new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').test(src) ||
  new RegExp('(?:const|let|var)\\s+' + name + '\\b').test(src);

console.log('\nКаждое имя, которое зовут наблюдаемые функции, объявлено');
let checked = 0;
for (const fn of WATCH) {
  const body = bodyOf(fn);
  if (!body) { ok(false, 'функция ' + fn + ' найдена в server.js'); continue; }
  // Вызовы: имя со скобкой, НЕ после точки (иначе это метод объекта)
  const clean = stripNoise(body);
  const names = new Set();
  for (const m of clean.matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) names.add(m[2]);
  // Локальные объявления внутри самой функции тоже считаем известными
  for (const m of clean.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)/g)) names.delete(m[1]);
  for (const m of clean.matchAll(/\(\s*([a-zA-Z_$][\w$]*)\s*(?:,|\))/g)) names.delete(m[1]);

  for (const n of names) {
    if (BUILTIN.has(n) || n === fn) continue;
    checked++;
    ok(declared(n), fn + ' зовёт ' + n,
      declared(n) ? '' : 'имени нет в server.js — упадёт при исполнении');
  }
}
ok(checked > 20, 'проверка действительно что-то смотрит', 'имён проверено: ' + checked);

console.log('\nСторож ловит подмену имени');
{
  // Подсовываем ту самую ошибку: getBalances вместо fetchAccountBalances
  const broken = src.replace('await fetchAccountBalances()', 'await getBalances()');
  const re = /(?:async\s+)?function\s+getBalances\s*\(/.test(broken) ||
    /(?:const|let|var)\s+getBalances\b/.test(broken);
  ok(broken !== src, 'подмена сделана');
  ok(!re, 'и такого имени в файле нет — сторож поднял бы тревогу');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
