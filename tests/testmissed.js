// Монета не должна исчезать из списка молча.
//
// ZEC стоял первым с пометкой «брать», а через две минуты пропал — притом что
// падение (6.6%), спред (0.05%) и объём (третье место на бирже) не менялись
// вовсе. Причина: скан делает около ста двадцати обращений к бирже каждые две
// минуты, часть их биржа отклоняет, повторов не было, а отказ по одной монете
// молча выбрасывал её из результата.
//
// Для панели, которая говорит, что покупать, исчезнувший кандидат — не мелочь:
// с экрана нельзя было отличить «условия перестали выполняться» от «данных не
// пришло».
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = read('server.js');

console.log('\nПовтор запроса к бирже');
{
  const i = src.indexOf('async function cbTry(url) {');
  ok(i > 0, 'общий помощник с повтором есть');
  const body = src.slice(i, src.indexOf('\n}', i));
  // Проверяем поведением
  const waits = [], timeouts = [];
  const ctx = { DIP_H: {}, setTimeout: (done, ms) => { waits.push(ms); done(); }, Promise, console,
    AbortSignal: { timeout: ms => { timeouts.push(ms); return { timeout: ms }; } } };
  vm.createContext(ctx);
  vm.runInContext(src.slice(i, src.indexOf('\n}', i) + 2) + ';this.cbTry = cbTry;', ctx);

  (async () => {
    let calls = 0;
    ctx.fetch = async (_url, opts) => { calls++; ok(opts.signal.timeout === 8000, 'запрос ограничен по времени'); return { ok: calls > 1, status: 429 }; };
    const r = await ctx.cbTry('x');
    ok(r && r.ok && calls === 2, 'первый отказ не хоронит запрос — второй заход выручает', 'обращений ' + calls);

    calls = 0;
    waits.length = 0;
    ctx.fetch = async () => { calls++; return { ok: false, status: 503 }; };
    ok(await ctx.cbTry('x') === null && calls === 3, 'три временных отказа — null, а не вечные попытки');
    ok(waits.join(',') === '1000,2000', 'между повторами возрастающие паузы');

    calls = 0;
    ctx.fetch = async () => { calls++; return { ok: false, status: 404 }; };
    ok(await ctx.cbTry('x') === null && calls === 1, 'постоянная ошибка не повторяется');

    calls = 0;
    ctx.fetch = async () => { calls++; throw new Error('сеть'); };
    ok(await ctx.cbTry('x') === null && calls === 3, 'обрыв сети тоже переживается и не роняет скан');

    console.log('\nПотеря видна, а не молчит');
    {
      ok(/const missed = \[\]/.test(src), 'скан считает непосчитанных');
      // DAI висел в «не посчитано» каждый проход: падать от суточного
      // максимума стейблкоину нечем, а место в корзине он занимал. Вечная
      // ложная тревога приучает не смотреть на настоящую.
      ok(/\.filter\(x => !STABLECOINS\.has\(x\.coin\)\)/.test(src),
        'стейблкоины в корзину скана не попадают');
      // Список один на всё приложение. Своих копий было две, они разошлись, и
      // сверка сетки брала в корзину монеты, которых скан не берёт: свечи по
      // ним не качались, и одно такое имя гасило оценку всей панели.
      ok(/const \{ STABLE: STABLECOINS \} = require\('\.\/src\/scalp\/scanner'\)/.test(src),
        'сервер берёт список стейблов из общего места');
      ok(!/const STABLECOINS = new Set\(/.test(src), 'своей копии списка на сервере не осталось');
      const { STABLE } = require('../src/scalp/scanner');
      ok(STABLE.has('USD1'), 'USD1 не попадает в рейтинг отката');
      ok(STABLE.has('PAXG'), 'PAXG (золото) тоже');
      ok(STABLE.has('WBTC'), 'WBTC тоже');
      ok(STABLE.has('RLUSD') && STABLE.has('USDG') && STABLE.has('ALUSD') && STABLE.has('MUSD'),
        'и те пятеро, из-за которых списки разошлись');
      ok(/ENTRY_PAPER_SKIP = new Set\([^\)]*USD1/.test(src), 'журнал не берёт USD1 в контроль');
      ok(/ENTRY_PAPER_SKIP = new Set\([^\)]*PAXG/.test(src), 'и не берёт PAXG');
      ok(/out\.results = out\.results\.filter\(r => !STABLECOINS\.has\(r\.coin\)\)/.test(src),
        'скальп-таблица тоже отбрасывает стейблы без смены отпечатка гейта');
      ok(/if \(!sig\) \{ missed\.push\(coin\); return; \}/.test(src), 'нет данных — монета в списке потерь');
      ok(/catch \{ missedDetails\[coin\] = [^;]+; missed\.push\(coin\);/.test(src), 'исключение даёт причину и имя пропущенной монеты');
      ok(/missed: entryScan\.missed \|\| \[\]/.test(src), 'список уходит в ответ панели');
      ok(/missedDetails: entryScan\.missedDetails \|\| \{\}/.test(src), 'причины тоже уходят в ответ');
      ok(/не посчитаны: ' \+ missed\.join/.test(src), 'и пишется в журнал сервера');
      // Помощник обязан использоваться там, где раньше был голый fetch
      ok(/const r = await cbTry\(`\$\{DIP_CB\}\/products\/\$\{coin\}-USD\/candles/.test(src), 'свечи тянутся с повтором');
      ok(/const r = await cbTry\(`\$\{DIP_CB\}\/products\/\$\{coin\}-USD\/ticker`\)/.test(src), 'спред тоже');

      for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
        const h = read(file);
        ok(/j\.missed && j\.missed\.length/.test(h), name + ': панель показывает потерю');
        ok(/не посчитано /.test(h), name + ': и называет число');
        ok(/Это не значит, что условия перестали выполняться/.test(h),
          name + ': и объясняет, что это не отказ по правилу');
        ok(/white-space:nowrap;">\$' \+ price\(x\.price\)/.test(h),
          name + ': цена в рейтинге не переносится посередине числа');
      }
    }

    console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
    process.exit(bad ? 1 : 0);
  })();
}
