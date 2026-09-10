// Сторож просадки: четыре состояния и отмена идущего расчёта — без браузера.
//
// Кнопка была одна и переключалась; теперь их две в общей рамке, и в каждом
// состоянии живая ровно одна. Проверяем то, что видит рука: что написано,
// какая кнопка нажимается, и что уходит на сервер.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync('public/index.html', 'utf8');
const start = src.indexOf('    // Сторож просадки: две кнопки в общей рамке');
const endMark = 'setInterval(loadDipWatches, 30000);';
const end = src.indexOf(endMark, start) + endMark.length;
if (start < 0 || end < start) { console.log('ПЛОХО  кусок про сторож просадки не найден'); process.exit(1); }

const mkBtn = () => ({ textContent: '', style: {}, title: '', disabled: false });
const go = mkBtn(), stop = mkBtn();
const coinEl = { value: 'AVAX' };
const alerts = [];
let resolveFetch, aborted = false, lastBody = null;
const ctx = {
  console, AbortController,
  document: {
    getElementById: (id) => (id === 'buyCoin' ? coinEl : id === 'dipGo' ? go : id === 'dipStop' ? stop : null),
  },
  showCustomAlert: (m, e) => alerts.push((e ? 'ERR: ' : '') + m),
  setTimeout: () => 0, setInterval: () => 0,
  fetch: (url, opt) => {
    if (opt && opt.body) lastBody = JSON.parse(opt.body);
    if (opt && opt.signal) {
      return new Promise((res, rej) => {
        resolveFetch = res;
        opt.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      });
    }
    return Promise.resolve({ json: async () => ({ success: true, watches: {} }) });
  },
};
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);

let bad = 0;
const ok = (c, n, d) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + n + (d ? '   ' + d : '')); };
const live = (b) => b.style.display !== 'none' && !b.disabled;

(async () => {
  console.log('\nСвободно: жать можно только «Ждать провал»');
  ctx.paintDipBtn();
  ok(go.textContent.includes('Ждать провал'), 'первая кнопка зовёт поставить сторож', go.textContent);
  ok(go.textContent.includes('AVAX'), 'и называет монету — сторож ставится на выбранную, а выбор потом меняется');
  ok(live(go), 'она живая');
  ok(!live(stop), 'останавливать нечего — вторая скрыта');

  console.log('\nСчитает: живая только отмена');
  const p = ctx.dipGo();
  await new Promise(r => setImmediate(r));
  ok(go.textContent.includes('считаю глубину'), 'сказано, что идёт расчёт', go.textContent);
  ok(!live(go), 'повторно поставить нельзя');
  ok(live(stop) && stop.textContent.includes('Отменить'), 'зато можно отменить', stop.textContent);
  ok(stop.style.color === '#ff453a', 'и она красная');

  console.log('\nОтмена во время расчёта');
  const p2 = ctx.dipStop();
  await p.catch(() => { });
  await p2;
  ok(aborted, 'запрос действительно прерван');
  // Сервер мог успеть поставить сторож между обрывом и ответом
  ok(lastBody && lastBody.enable === false, 'и на сервер ушло снятие сторожа', JSON.stringify(lastBody));
  ok(alerts.some(a => a.includes('отменён')), 'сказано, что расчёт отменён', alerts.join(' | '));
  ok(go.textContent.includes('Ждать провал') && live(go), 'кнопка вернулась в исходное', go.textContent);

  console.log('\nЖдёт: цель видна, снять можно');
  ctx.fetch = () => Promise.resolve({
    json: async () => ({ success: true, watches: { AVAX: { dipPct: 1.5, targetPx: 7.5, startPx: 7.62, why: 'тест' } } }),
  });
  await ctx.loadDipWatches();
  ok(go.textContent.includes('ждём −1.5%'), 'состояние «ждёт» с целью', go.textContent);
  ok(!live(go), 'второй сторож на ту же монету не поставить');
  ok(live(stop) && stop.textContent.includes('Стоп'), 'снять можно', stop.textContent);
  ok(String(stop.title).includes('7.5'), 'цель видна в подсказке');

  console.log('\nСработал: одноразовый, пока не сбросили');
  ctx.fetch = () => Promise.resolve({
    json: async () => ({ success: true, watches: { AVAX: { dipPct: 1.5, fellPct: -1.71, firedPx: 7.49, fired: true } } }),
  });
  await ctx.loadDipWatches();
  // fellPct приходит со знаком: без Math.abs получалось «−-1.71%»
  ok(go.textContent.includes('упал на 1.71%'), 'показано, на сколько упал', go.textContent);
  ok(!live(go), 'заново не ставится, пока не сброшен');
  ok(stop.textContent.includes('Сбросить') && live(stop), 'сбросить можно', stop.textContent);

  console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе проверки прошли');
  process.exit(bad ? 1 : 0);
})();
