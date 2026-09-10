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
  ok(/for \(let a = 0; a < 2; a\+\+\)/.test(body), 'ровно один повтор, а не бесконечный цикл');
  ok(/setTimeout\(s, 400\)/.test(body), 'между попытками есть пауза');

  // Проверяем поведением
  const ctx = { DIP_H: {}, setTimeout, Promise, console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(i, src.indexOf('\n}', i) + 2) + ';this.cbTry = cbTry;', ctx);

  (async () => {
    let calls = 0;
    ctx.fetch = async () => { calls++; return { ok: calls > 1 }; };
    const r = await ctx.cbTry('x');
    ok(r && r.ok && calls === 2, 'первый отказ не хоронит запрос — второй заход выручает', 'обращений ' + calls);

    calls = 0;
    ctx.fetch = async () => { calls++; return { ok: false }; };
    ok(await ctx.cbTry('x') === null && calls === 2, 'два отказа подряд — честный null, а не вечные попытки');

    calls = 0;
    ctx.fetch = async () => { calls++; throw new Error('сеть'); };
    ok(await ctx.cbTry('x') === null && calls === 2, 'обрыв сети тоже переживается и не роняет скан');

    console.log('\nПотеря видна, а не молчит');
    {
      ok(/const missed = \[\]/.test(src), 'скан считает непосчитанных');
      ok(/if \(!sig\) \{ missed\.push\(coin\); return; \}/.test(src), 'нет данных — монета в списке потерь');
      ok(/catch \{ missed\.push\(coin\);/.test(src), 'и исключение тоже, а не просто проглатывается');
      ok(/missed: entryScan\.missed \|\| \[\]/.test(src), 'список уходит в ответ панели');
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
      }
    }

    console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
    process.exit(bad ? 1 : 0);
  })();
}
