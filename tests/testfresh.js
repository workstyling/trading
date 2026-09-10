// Счётчик должен идти сам, считать от времени СЕРВЕРА и не уходить в минус.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('public/index.html', 'utf8');
const start = src.indexOf('const _freshState = {}');
const endMark = 'setInterval(paintFreshness, 1000);';
const end = src.indexOf(endMark, start) + endMark.length;

const els = {};
let now = 1_700_000_000_000;
const intervals = [];
const ctx = {
  console,
  // Счётчик пишет через общий «живой» писатель — он объявлен выше вырезанного
  // куска. Здесь важен результат, а не то, пересобрался узел или нет.
  setLiveHtml: (el, html) => { if (el) el.innerHTML = html; },
  setText: (el, s) => { if (el) el.innerHTML = String(s); },
  document: { getElementById: id => (els[id] ||= { innerHTML: '' }) },
  Date: class extends Date { static now() { return now; } },
  setInterval: (fn, ms) => { intervals.push({ fn, ms, next: now + ms }); return intervals.length; },
};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);

const tick = (ms) => { const t = now + ms; while (now < t) { now += 1000; for (const i of intervals) while (i.next <= now) { i.next += i.ms; i.fn(); } } };
const txt = id => (els[id] ? els[id].innerHTML.replace(/<[^>]*>/g, '') : '');

let bad = 0;
const ok = (c, n, d) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'FAIL') + '  ' + n + (d ? '   ' + d : '')); };

// Часы браузера на 30с впереди сервера — счётчик не должен это унаследовать
ctx.trackFreshness('msAgo', { at: now - 30000 - 5000, intervalMs: 120000, serverNow: now - 30000 });
ok(/^0с назад/.test(txt('msAgo')) || /^5с назад/.test(txt('msAgo')), 'учитывает сдвиг часов сервера', txt('msAgo'));

tick(10000);
ok(/^15с назад/.test(txt('msAgo')), 'счётчик идёт сам', txt('msAgo'));
ok(/через 1м 45с/.test(txt('msAgo')), 'отсчёт до следующего скана', txt('msAgo'));

tick(120000);
ok(/обновляется…/.test(txt('msAgo')), 'просроченный скан не уходит в минус', txt('msAgo'));
ok(/^2м/.test(txt('msAgo')), 'минуты и секунды', txt('msAgo'));

// вторая панель считается независимо
ctx.trackFreshness('ssAgo', { at: now - 3000, intervalMs: 240000, serverNow: now });
tick(2000);
ok(/^5с назад/.test(txt('ssAgo')), 'вторая панель со своим временем', txt('ssAgo'));
ok(/через 3м 5[0-9]с/.test(txt('ssAgo')), 'свой период у второй панели', txt('ssAgo'));

console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе проверки прошли');

// Без этого запускатор считает набор зелёным: он смотрит на код выхода,

// а не на печать. Три провала так и ехали мимо ворот выкатки.

process.exit(bad ? 1 : 0);
