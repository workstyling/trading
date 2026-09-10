// Запускатор проверок. Один вход: `npm test`.
//
// Раньше наборы лежали в общей временной папке на одном ноутбуке. Их нельзя
// было запустить с сервера, нельзя было запустить на другой машине, и никто
// не мог сказать, какие из них ещё живые: часть молча падала месяцами. Теперь
// они в репозитории, едут вместе с кодом, и выкатка на них опирается.
//
// Наборы, которым нужен файл вёрстки, перечислены с аргументами. Те, что
// проверяют обе вёрстки, стоят дважды: однажды десктоп и телефон разошлись, и
// телефон звал покупать то, что десктоп запрещал.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DESK = 'public/index.html';
const MOB = 'public/mobile/index.html';

// Наборы, которым файл вёрстки передаётся аргументом
const PER_LAYOUT = ['testbar', 'testbuy', 'testflash', 'testheight', 'testspark2', 'teststeady'];

function suites() {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js') && f !== 'run.js')
    .sort();
  const out = [];
  for (const f of files) {
    const name = f.replace(/\.js$/, '');
    if (PER_LAYOUT.includes(name)) {
      out.push({ name: name + ' (десктоп)', file: f, args: [DESK] });
      out.push({ name: name + ' (мобильная)', file: f, args: [MOB, 'M'] });
    } else {
      out.push({ name, file: f, args: [] });
    }
  }
  return out;
}

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
const verbose = process.argv.includes('-v');

const list = suites().filter(s => !only.length || only.some(o => s.name.includes(o)));
let failed = [];
const t0 = Date.now();

for (const s of list) {
  // Проверки читают файлы по путям от корня проекта — оттуда и запускаем
  const r = spawnSync(process.execPath, [path.join(__dirname, s.file), ...s.args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const bad = r.status !== 0;
  if (bad) failed.push({ name: s.name, out });
  process.stdout.write((bad ? '  ПЛОХО  ' : '  ok     ') + s.name + '\n');
  if (verbose) process.stdout.write(out.replace(/^/gm, '      ') + '\n');
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (failed.length) {
  for (const f of failed) {
    console.log('\n─── ' + f.name + ' ───');
    // Хвоста хватает: проверки печатают провалы последними
    console.log(f.out.split('\n').slice(-25).join('\n'));
  }
  console.log('\nПЛОХО: ' + failed.length + ' из ' + list.length + ' за ' + secs + ' с');
  process.exit(1);
}
console.log('\nвсё зелено: ' + list.length + ' наборов за ' + secs + ' с');
