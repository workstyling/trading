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
    Number, String, parseFloat, Promise, Boolean, AbortSignal,
    fetch: async () => ({ ok: true, json: async () => ({ success: true, balances, stale: false }) }),
    balancesCache: balances,
    fmtSize: (n) => String(n),
    showCustomAlert: (t) => asked.push({ kind: 'alert', t }),
    showOrderError: (t, html) => asked.push({ kind: 'error', t, html }),
    showConfirmModal: (t, html, yes, no) => { asked.push({ kind: 'confirm', t, html, yes, no }); },
    lastPricesCache: {},
  };
  vm.createContext(ctx);
  const i = d.indexOf('async function sellableSize');
  vm.runInContext(d.slice(i, d.indexOf('\n    }', i) + 6) + ';this.sellable = sellableSize;', ctx);
  ctx.asked = asked;
  // Отвечаем на окно подтверждения, как ответил бы человек
  ctx.answer = async (yes) => {
    for (let i = 0; i < 10; i++) {
      const c = asked.find(a => a.kind === 'confirm');
      if (c) { (yes ? c.yes : c.no)(); return; }
      await Promise.resolve();
    }
    throw new Error('Confirmation did not open');
  };
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
    await ctx.answer(true);
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
    await ctx.answer(false);
    ok((await p) === null, 'при отказе ордер не уходит');
  }

  console.log('\nЗаморожено в открытом ордере — причина другая');
  {
    const ctx = load([{ currency: 'CRO', available: '600', hold: '400' }]);
    const p = ctx.sellable('CRO', '1000');
    await ctx.answer(true);
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

  console.log('\nСТОП-ЛИМИТ НА 0.001 МОНЕТЫ — ТОТ САМЫЙ СЛУЧАЙ');
  {
    // По VVV в кошельке лежало 100.466, из них 100.465 заморожено открытой
    // заявкой, свободно 0.001. Панель урезала предлагаемый объём до свободного
    // ЕЩЁ ДО окна — и окно не увидело расхождения, потому что расхождение уже
    // было спрятано. Кнопка «Sell Stop» ушла на 0.001 монеты, ордер исполнился
    // на три цента, позиция осталась открытой.
    const ctx = load([{ currency: 'VVV', available: '0.001', hold: '100.465' }]);
    ctx.lastPricesCache['VVV-USD'] = { bestBid: '32.4793' };
    const got = await ctx.sellable('VVV', '100.465');
    ok(got === null, 'сделка на три цента не предлагается вовсе', String(got));
    const e = ctx.asked[0];
    ok(e && e.kind === 'error', 'это отказ с объяснением, а не выбор', e && e.kind);
    ok(e && /Почти всё заморожено/.test(e.t), 'названо, что произошло', e && e.t);
    ok(e && /100\.465/.test(e.html), 'сказано, сколько занято ордером');
    ok(e && /\$0\.03/.test(e.html), 'и сколько стоит свободный остаток',
      e && (e.html.match(/\$[\d.]+/) || [])[0]);
    ok(e && /[Сс]ними/.test(e.html), 'и что делать, чтобы продать всё');

    // А заметная свободная часть по-прежнему предлагается
    const big = load([{ currency: 'VVV', available: '50', hold: '50.465' }]);
    big.lastPricesCache['VVV-USD'] = { bestBid: '32.4793' };
    const p = big.sellable('VVV', '100.465');
    await big.answer(true);
    ok((await p) === 50, 'половину позиции продать всё ещё можно');

    // Цены нет — молча не блокируем
    const noPx = load([{ currency: 'VVV', available: '0.001', hold: '100.465' }]);
    const p2 = noPx.sellable('VVV', '100.465');
    await noPx.answer(true);
    ok((await p2) === 0.001, 'без цены проверку пропускаем, а не запрещаем наугад');
  }

  console.log('\nБаланс отсутствует или повреждён — продажа не отправляется');
  {
    const ctx = load([]);
    ok((await ctx.sellable('X', '100')) === null, 'без остатка продажа запрещена');
    ok(ctx.asked.length === 1 && ctx.asked[0].kind === 'error', 'причина показана');
    const nan = load([{ currency: 'X', available: 'нет', hold: '0' }]);
    ok((await nan.sellable('X', '100')) === null, 'нечитаемый баланс блокирует продажу');
  }

  console.log('\nНечего продавать');
  {
    const ctx = load([{ currency: 'X', available: '100', hold: '0' }]);
    ok((await ctx.sellable('X', '0')) === null, 'нулевой объём не продаётся');
    ok((await ctx.sellable('X', 'абв')) === null, 'и мусор тоже');
  }

  console.log('\nЛимитная продажа называет убыток словом');
  {
    // Окно спрашивало «продать 11 820.90 по $0.2563?» и показывало сумму
    // сделки. Сумма — не ответ на вопрос, который тут решается: $0.2563 и
    // $0.2608 на глаз одинаковы, а между ними полсотни долларов и граница
    // между прибылью и убытком. У стоп-лимита и у продажи по Ask
    // предупреждение было, у обычной лимитки — нет.
    const run = async (price, size, cost, avail) => {
      const shown = [];
      const ctx = {
        Number, String, parseFloat, Promise, Math, Boolean, AbortSignal,
        balancesCache: [{ currency: 'USELESS', available: String(avail), hold: '0' }],
        fmtSize: (n) => String(n),
        getFeeLimit: () => 0.001, getFeeMarket: () => 0.0015,
        document: { getElementById: () => ({ value: price }) },
        showCustomAlert: (t) => shown.push({ kind: 'alert', t }),
        showOrderError: (t, html) => shown.push({ kind: 'error', t, html }),
        showConfirmModal: (t, html, yes, no) => {
          shown.push({ kind: 'confirm', t, html, yes, no });
          if (/Свободно меньше/.test(t)) yes();
        },
        fetch: async () => ({ ok: true, json: async () => ({ success: true, stale: false,
          balances: [{ currency: 'USELESS', available: String(avail), hold: '0' }] }) }),
        selectedOrders: [], safeStorage: { setItem() {} }, saveSelectedToServer() {},
        loadLatestOrders: async () => {}, loadUsdBalance() {}, loadVolume30d() {},
        SELECTED_ORDERS_KEY: 'k', JSON,
      };
      vm.createContext(ctx);
      const si = d.indexOf('async function sellableSize');
      vm.runInContext(d.slice(si, d.indexOf('\n    }', si) + 6), ctx);
      const li = d.indexOf('async function sellAllLimit');
      vm.runInContext(d.slice(li, d.indexOf('\n    }', li) + 6) + ';this.go = sellAllLimit;', ctx);
      const p = ctx.go('USELESS-USD', size, 'USELESS', cost);
      await p;
      return shown;
    };

    // Продажа в убыток: 11 820.90 по $0.2563 против затрат $3068.31
    let shown = await run('0.2563', '11820.9', 3068.31, 11820.9);
    let c = shown.find(s => s.kind === 'confirm');
    ok(c && /в убыток/i.test(c.t), 'убыток вынесен в заголовок окна', c && c.t);
    ok(c && /Зафиксирует убыток/.test(c.html), 'и назван словом в теле');
    ok(c && /−\$/.test(c.html), 'со знаком минуса', (c.html.match(/−\$[\d.]+/) || [])[0]);
    ok(c && /%\)/.test(c.html), 'и в процентах тоже');
    ok(c && /если ордер постоит в стакане/.test(c.html), 'сказано, при какой комиссии это посчитано');
    ok(c && /заберёт встречную сразу/.test(c.html), 'и второй вариант комиссии тоже назван');

    // Та же позиция в плюс
    shown = await run('0.2700', '11820.9', 3068.31, 11820.9);
    c = shown.find(s => s.kind === 'confirm');
    ok(c && !/в убыток/i.test(c.t), 'прибыльная продажа красным не пугает', c && c.t);
    ok(c && /Прибыль \+\$/.test(c.html), 'и прибыль названа числом',
      (c.html.match(/Прибыль \+\$[\d.]+/) || [])[0]);

    // Затраты делятся в той же доле, что и монеты
    shown = await run('0.2563', '11858.7', 3078.12, 11820.9);
    c = shown.find(s => s.kind === 'confirm' && !/Свободно меньше/.test(s.t));
    const num = c && parseFloat((c.html.match(/убыток −\$([\d.]+)/) || [])[1]);
    // 11820.9 x 0.2563 x (1-0.001) = 3026.67; затраты 3078.12 x (11820.9/11858.7) = 3068.31
    ok(num && Math.abs(num - 41.64) < 0.1,
      'убыток посчитан по доле затрат, а не по всей позиции', '−$' + num);
    // По всей позиции вышло бы −$51.45: на $9.81 больше, чем есть на самом деле
    ok(num && num < 45, 'иначе он был бы завышен на стоимость непроданных монет', '−$' + num);
  }

  console.log('\nЗатраты делятся везде, где количество урезано');
  {
    for (const fn of ['sellAtCurrentAsk', 'sellAllLimit', 'sellStopInline', 'sellAllMarket']) {
      const body = d.slice(d.indexOf('function ' + fn), d.indexOf('function ' + fn) + 2800);
      ok(/const wanted = parseFloat\(size\)|const wanted/.test(body), fn + ': исходное количество запомнено');
      ok(/\* \(wanted > 0 \? sellable \/ wanted : 0\)/.test(body), fn + ': затраты поделены в той же доле');
    }
  }

  console.log('\nПанель считает по продаваемому количеству, а не по выбранному');
  {
    // «Выбрано» — сумма выбранных ордеров, и она бывает больше кошелька: по
    // USELESS 11 858.70 против 11 820.90. Кнопки брали табличное число, и на
    // каждую продажу выскакивало окно про расхождение — при том что человек
    // продавал ровно то, что у него есть. А числа рядом с полем лимитки
    // считались от одного количества, тогда как в ордер уходило другое: на
    // экране −$40.22, в подтверждении −$41.64.
    const pick = (selected, wallet) => Math.min(selected, wallet);
    ok(pick(11858.7, 11820.9) === 11820.9, 'берётся кошелёк, когда его меньше');
    // Больше выбранного не берём: в кошельке могут лежать монеты не из этой
    // позиции, и «продать всё» не должно означать «продать и их».
    ok(pick(11858.7, 50000) === 11858.7, 'и выбранное, когда кошелёк больше');
    const share = (cost, sell, sel) => sel > 0 ? cost * (sell / sel) : 0;
    ok(Math.abs(share(3078.12, 11820.9, 11858.7) - 3068.31) < 0.05,
      'затраты делятся в той же доле', '$' + share(3078.12, 11820.9, 11858.7).toFixed(2));

    // Берётся ВЕСЬ кошелёк, а не свободная часть: заморозка в открытом ордере
    // — это «сними ту заявку», а не «этих монет нет». Урезание здесь обходило
    // окно, которое об этом и предупреждает.
    ok(/const sellNow = Number\.isFinite\(walletFree\) \? Math\.min\(totalFilled, walletFree\) : totalFilled;/.test(d),
      'продаваемое количество считается один раз на группу');
    ok(/const walletFree = !walletKnown \? null[\s\S]{0,120}parseFloat\(walletRow\.available\) \+ parseFloat\(walletRow\.hold \|\| 0\) : 0;/.test(d),
      'и включает замороженное — это тоже твои монеты');
    ok(/const sellNowCost = totalFilled > 0 \? totalUSD \* \(sellNow \/ totalFilled\) : 0;/.test(d),
      'и его доля затрат тоже');
    // Все кнопки и подписи в строке монеты берут его, а не табличное число
    for (const call of ['sellAllCoin', 'sellAllMarket', 'sellAllLimit', 'sellStopInline',
                        'previewLimitSell', 'recalcSellSteps', 'bumpSellStep', 'sellStepInfoHtml']) {
      const uses = d.match(new RegExp(call + "\\([^)]{0,160}", 'g')) || [];
      const row = uses.find(u => /sellNow|totalFilled|totalUSD/.test(u));
      ok(row && /sellNow/.test(row) && !/totalFilled|totalUSD/.test(row),
        call + ': берёт продаваемое количество', row && row.slice(0, 70));
    }
    // Расхождение объяснено прямо в строке, а не только в окне при нажатии
    ok(/в кошельке \$\{fmtSize\(sellNow\)\} — на \$\{fmtSize\(shortBy\)\} меньше/.test(d),
      'разница названа в самой строке монеты');
    // Заморозка — отдельная строка: с экрана «продано» и «занято ордером»
    // выглядят одинаково, а делать с ними надо разное.
    ok(/заморожено \$\{fmtSize\(Math\.min\(heldNow, sellNow\)\)\} в открытом ордере/.test(d),
      'заморожённое в открытом ордере названо отдельно');
    ok(/\$\{shortNote\}\$\{heldNote\}/.test(d), 'и стоит в той же строке монеты');
    ok(/const shortBy = totalFilled - sellNow;/.test(d), 'и посчитана явно');
    // Кнопки исчезают, когда продавать нечего, а не предлагают ноль
    ok(/\$\{sellNow > 0 \? `<button class="sell-all-btn"/.test(d),
      'при нулевом остатке кнопок продажи нет');
  }

  console.log('\nВсе кнопки продажи идут через одну проверку');
  {
    for (const fn of ['sellAtCurrentAsk', 'sellAllLimit', 'sellStopInline', 'sellAllMarket']) {
      const body = d.slice(d.indexOf('function ' + fn), d.indexOf('function ' + fn) + 2500);
      ok(/const sellable = await sellableSize\(coin, size,/.test(body) && /if \(sellable == null\) return;/.test(body),
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
    const helper = m.slice(m.indexOf('async function sellableSizeM'), m.indexOf('async function sellAtAsk'));
    ok(helper.length > 200, 'проверка вынесена в одну функцию, как на десктопе');
    ok(/Свободно меньше выбранного/.test(helper), 'спрашивается тем же вопросом');
    ok(/Продать свободные/.test(helper), 'предложение названо');
    ok(/нет вовсе/.test(helper), 'а когда свободного нет — это ошибка');
    ok(/снятая заявка/.test(helper) && /снятая заявка/.test(d), 'причина названа в обеих вёрстках');
    ok(!/Биржа отклоняет такой ордер целиком, поэтому он даже не отправлен/.test(m),
      'мобильная: тупикового окна больше нет');
    // Все три кнопки продажи на телефоне — через неё же
    for (const fn of ['sellAtAsk', 'sellStopInlineM', 'sellAllMarketM']) {
      const body = m.slice(m.indexOf('function ' + fn), m.indexOf('function ' + fn) + 1600);
      ok(/await sellableSizeM\(coin, s(?:z|ize),/.test(body), fn + ': спрашивает свободный остаток');
      ok(/== null\) return;/.test(body), fn + ': и при отказе ордер не уходит');
    }
    // Затраты делятся в той же доле — иначе убыток в окне завышен
    ok((m.match(/parseFloat\(actualCost\) \|\| 0\) \* \(/g) || []).length >= 2,
      'затраты делятся в той же доле, что и монеты');
    ok(/cost = \(parseFloat\(cost\) \|\| 0\) \* \(wantedS > 0/.test(m), 'и у стоп-лимита тоже');
    ok(/let sz = parseFloat\(size\);/.test(m), 'количество на телефоне можно уменьшить');
  }

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
