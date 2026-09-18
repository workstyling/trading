// Продать нельзя, а почему — не сказано, и что делать — тоже.
//
// Проверка сравнивала выбранное в таблице со свободным остатком и на
// расхождении показывала «Продавать нечего». Но продавать как раз есть что:
// по USELESS выбрано 11 858.70, свободно 11 820.90 — разница 37.80, которые
// уже продала снятая заявка. Биржа отклонила бы ордер на выбранное целиком,
// поэтому он и не отправлялся, — а человек оставался с кнопкой, которая не
// работает и не объясняет, что делать дальше.
//
// Предлагаем то количество, которое пройдёт, и называем разницу: решение
// остаётся за человеком, а не подменяется молча.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const d = fs.readFileSync('public/index.html', 'utf8');
const m = fs.readFileSync('public/mobile/index.html', 'utf8');

function load(balances) {
  const asked = [];
  const ctx = {
    Number, String, parseFloat, Promise, Boolean,
    balancesCache: balances,
    fmtSize: (n) => String(n),
    showCustomAlert: (t) => asked.push({ kind: 'alert', t }),
    showOrderError: (t, html) => asked.push({ kind: 'error', t, html }),
    showConfirmModal: (t, html, yes, no) => { asked.push({ kind: 'confirm', t, html, yes, no }); },
  };
  vm.createContext(ctx);
  const i = d.indexOf('async function sellableSize');
  vm.runInContext(d.slice(i, d.indexOf('\n    }', i) + 6) + ';this.sellable = sellableSize;', ctx);
  ctx.asked = asked;
  // Отвечаем на окно подтверждения, как ответил бы человек
  ctx.answer = (yes) => { const c = asked.find(a => a.kind === 'confirm'); if (c) (yes ? c.yes : c.no)(); };
  return ctx;
}

(async () => {
  console.log('\nСвободного хватает — ничего не спрашиваем');
  {
    const ctx = load([{ currency: 'USELESS', available: '11858.7', hold: '0' }]);
    const got = await ctx.sellable('USELESS', '11858.7');
    ok(got === 11858.7, 'возвращается то же количество', String(got));
    ok(ctx.asked.length === 0, 'и никаких окон');
  }

  console.log('\nСвободного меньше — предлагаем свободное');
  {
    // Настоящие числа USELESS
    const ctx = load([{ currency: 'USELESS', available: '11820.9', hold: '0' }]);
    const p = ctx.sellable('USELESS', '11858.7');
    ctx.answer(true);
    const got = await p;
    ok(got === 11820.9, 'продаём свободное, а не выбранное', String(got));
    const c = ctx.asked[0];
    ok(c && c.kind === 'confirm', 'спрошено подтверждением, а не тупиковой ошибкой', c && c.kind);
    ok(c && /11858\.7/.test(c.html) && /11820\.9/.test(c.html), 'оба числа названы');
    ok(c && /37\.8/.test(c.html), 'и разница между ними тоже', '37.8');
    ok(c && /снятая заявка/.test(c.html), 'сказано, куда делась разница');
  }

  console.log('\nОтказ — значит не продаём');
  {
    const ctx = load([{ currency: 'USELESS', available: '11820.9', hold: '0' }]);
    const p = ctx.sellable('USELESS', '11858.7');
    ctx.answer(false);
    ok((await p) === null, 'при отказе ордер не уходит');
  }

  console.log('\nЗаморожено в открытом ордере — причина другая');
  {
    const ctx = load([{ currency: 'CRO', available: '600', hold: '400' }]);
    const p = ctx.sellable('CRO', '1000');
    ctx.answer(true);
    ok((await p) === 600, 'свободное всё равно можно продать');
    const c = ctx.asked[0];
    ok(c && /заморожено/i.test(c.html), 'заморозка названа');
    ok(c && /сними тот ордер/i.test(c.html), 'и сказано, что делать, чтобы продать всё');
    ok(c && !/снятая заявка/.test(c.html), 'а про снятую заявку тут не выдумывается');
  }

  console.log('\nСвободного нет вовсе');
  {
    const ctx = load([{ currency: 'CRO', available: '0', hold: '1000' }]);
    ok((await ctx.sellable('CRO', '1000')) === null, 'продавать действительно нечего');
    ok(ctx.asked[0] && ctx.asked[0].kind === 'error', 'и это ошибка, а не выбор');
    ok(/нет вовсе/.test(ctx.asked[0].html), 'сказано прямо');
    ok(/1000/.test(ctx.asked[0].html), 'и названо, сколько заморожено');
  }

  console.log('\nБаланса не видно — не мешаем');
  {
    const ctx = load([]);
    ok((await ctx.sellable('X', '100')) === 100, 'без баланса пропускаем: биржа ответит сама');
    ok(ctx.asked.length === 0, 'и не спрашиваем впустую');
    const nan = load([{ currency: 'X', available: 'нет', hold: '0' }]);
    ok((await nan.sellable('X', '100')) === 100, 'нечитаемый баланс тоже не блокирует');
  }

  console.log('\nНечего продавать');
  {
    const ctx = load([{ currency: 'X', available: '100', hold: '0' }]);
    ok((await ctx.sellable('X', '0')) === null, 'нулевой объём не продаётся');
    ok((await ctx.sellable('X', 'абв')) === null, 'и мусор тоже');
  }

  console.log('\nВсе кнопки продажи идут через одну проверку');
  {
    for (const fn of ['sellAtCurrentAsk', 'sellAllLimit', 'sellStopInline', 'sellAllMarket']) {
      const body = d.slice(d.indexOf('function ' + fn), d.indexOf('function ' + fn) + 2500);
      ok(/const sellable = await sellableSize\(coin, size\);/.test(body) && /if \(sellable == null\) return;/.test(body),
        fn + ': спрашивает свободный остаток');
      ok(/size = String\(sellable\)/.test(body), fn + ': и в ордер уходит именно оно');
    }
    // SELL ALL — это та же функция, что и Ask
    ok(/async function sellAllCoin[\s\S]{0,200}await sellAtCurrentAsk\(/.test(d),
      'SELL ALL идёт через ту же проверку');
    // Прежнего тупика не осталось
    ok(!/Биржа отклоняет такой ордер целиком, поэтому он даже не отправлен/.test(d),
      'десктоп: тупикового окна больше нет');
  }

  console.log('\nТелефон ведёт себя так же');
  {
    const body = m.slice(m.indexOf('async function sellAtAsk'), m.indexOf('async function cancelOrder'));
    ok(/let sz = parseFloat\(size\);/.test(body), 'количество можно уменьшить');
    ok(/Свободно меньше выбранного/.test(body), 'спрашивается тем же вопросом');
    ok(/sz = avail;[\s\S]{0,60}size = String\(avail\);/.test(body),
      'и в ордер, и в расчёт прибыли уходит свободное');
    ok(/Продать свободные/.test(body), 'предложение названо');
    ok(/нет вовсе/.test(body), 'а когда свободного нет — это ошибка');
    ok(!/Биржа отклоняет такой ордер целиком, поэтому он даже не отправлен/.test(m),
      'мобильная: тупикового окна больше нет');
    // Обе вёрстки объясняют разницу одинаково: расхождение между ними однажды
    // уже кончилось тем, что телефон звал покупать запрещённое на десктопе.
    ok(/снятая заявка/.test(body) && /снятая заявка/.test(d), 'причина названа в обеих вёрстках');
  }

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
