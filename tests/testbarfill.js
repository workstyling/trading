// Цена со шкалы должна попадать в поле, из которого ставится продажа.
//
// Шкала отвечает на один вопрос: по какой цене сколько выйдет. Ответ нужен
// ровно в одном месте — в поле лимитной продажи. Пока он уезжал только в
// буфер обмена, переносить его приходилось глазами и руками, а числа вроде
// 0.25755 и 0.2563 на глаз почти одно и то же: разница между ними — восемь
// долларов на позиции, и увидеть промах нечем, пока ордер не выставлен.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

// Крошечный DOM: шкала, группа монеты и поле лимитки. Больше обработчику не нужно.
function mkScale({ coin = 'ENA', withInput = true, filled = 100, spent = 2500, buyPrice = 0.25 } = {}) {
  const alerts = [], copied = [], events = [];
  const input = withInput ? {
    id: 'limitSellPrice_' + coin, value: '',
    dispatchEvent(e) { events.push(e.type); return true; },
  } : null;
  const group = { dataset: { coin } };
  const bar = {
    getBoundingClientRect: () => ({ left: 0, width: 200 }),
    querySelector: (s) => ({ style: {}, offsetWidth: 80,
      innerHTML: '', get textContent() { return ''; }, tagName: s }),
  };
  const container = {
    dataset: { filled: String(filled), spent: String(spent), buyPrice: String(buyPrice),
      leftMax: '-2', rightMax: '1', orderId: 'c0ee6f11', pair: coin + '-USD' },
    querySelector: () => bar,
    closest: (sel) => (sel === '.coin-group' ? group : null),
    addEventListener(type, fn) { (this._h = this._h || {})[type] = fn; },
  };
  // Верхняя таблица группы: из неё берётся результат всей позиции
  group.querySelector = () => ({ dataset: { filled: '400', usd: '10000' } });

  const ctx = {
    Math, Number, String, parseFloat, JSON, Boolean,
    console: { log: () => {} },
    document: {
      getElementById: (id) => (input && id === input.id ? input : null),
      createElement: () => ({ style: { cssText: '' }, select() {}, set value(v) { copied.push(v); } }),
      body: { appendChild() {}, removeChild() {} },
      execCommand: () => true,
    },
    Event: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
    getFeeMarket: () => 0.0015,
    getFeeLimit: () => 0.001,
    priceTick: () => ({ then: (f) => f(5) }),
    showCustomAlert: (m) => alerts.push(m),
  };
  ctx.document.execCommand = ctx.document.execCommand;
  vm.createContext(ctx);
  // roundToTick — своя, настоящая
  const ri = h.indexOf('function roundToTick');
  vm.runInContext(h.slice(ri, h.indexOf('\n    }', ri) + 6), ctx);
  // Обвязка шкалы как есть, обёрнутая в функцию с нашим контейнером
  const from = h.indexOf("const bar = container.querySelector('.price-progress-bar');");
  const to = h.indexOf("      });\n      // Show real balances from cache", from);
  vm.runInContext('this.wire = function (container) {\n' +
    h.slice(from, to).replace(/document\.execCommand\('copy'\)/, 'document.execCommand()') +
    '\n};', ctx);
  ctx.wire(container);
  return { container, input, alerts, copied, events, ctx,
    click: (x) => container._h.click({ clientX: x }) };
}

console.log('\nНажатие ставит цену в поле');
{
  const s = mkScale({ buyPrice: 0.25, filled: 100, spent: 25 });
  s.click(100);                                   // ровно середина: −2% .. +1% -> −0.5%
  ok(s.input.value !== '', 'поле заполнено, а не осталось пустым', s.input.value);
  ok(Number(s.input.value) > 0, 'и это число', s.input.value);
  // Та же цена, что показывает подсказка и что уходит в буфер
  ok(s.copied[0] === s.input.value, 'в поле и в буфере одна и та же цена',
    s.copied[0] + ' / ' + s.input.value);
  ok(Math.abs(Number(s.input.value) - 0.25 * (1 - 0.005)) < 1e-6,
    'цена соответствует месту нажатия', s.input.value);
  ok(s.events.includes('input'), 'соседнее число пересчитывается — событие поля отправлено');
  ok(/В поле лимита/.test(s.alerts[0] || ''), 'сказано, что произошло', s.alerts[0]);
  ok(/этот ордер/.test(s.alerts[0] || '') && /вся выбранная позиция/.test(s.alerts[0] || ''),
    'и оба результата по-прежнему названы');
}

console.log('\nРазные места шкалы дают разные цены');
{
  const s = mkScale({ buyPrice: 0.25 });
  s.click(0);
  const low = Number(s.input.value);
  s.click(200);
  const high = Number(s.input.value);
  ok(low < high, 'слева цена ниже, справа выше', low + ' -> ' + high);
  ok(Math.abs(low - 0.25 * 0.98) < 1e-6, 'левый край это −2%', String(low));
  ok(Math.abs(high - 0.25 * 1.01) < 1e-6, 'правый край это +1%', String(high));
  ok(s.events.length === 2, 'каждое нажатие пересчитывает число рядом');
}

console.log('\nБез поля нажатие не ломается');
{
  // Поле есть только у позиции с остатком: у закрытой его в разметке нет.
  const s = mkScale({ withInput: false });
  let threw = false;
  try { s.click(100); } catch { threw = true; }
  ok(!threw, 'нажатие по шкале закрытой позиции не бросает ошибку');
  ok(s.copied.length === 1, 'цена всё равно копируется');
  ok(/Скопировано/.test(s.alerts[0] || ''), 'и подпись говорит именно про буфер', s.alerts[0]);
  ok(!/В поле лимита/.test(s.alerts[0] || ''), 'а не врёт про поле, которого нет');
}

console.log('\nПоле берётся у монеты, а не у ордера');
{
  // Шкал в группе столько, сколько строк ордеров, а поле продажи одно.
  ok(/container\.closest\('\.coin-group'\)\?\.dataset\.coin/.test(h),
    'монета читается из группы');
  ok(/getElementById\('limitSellPrice_' \+ barCoin\)/.test(h), 'и поле ищется по ней');
  // Деньги рядом с полем считает его собственный обработчик: второй арифметики
  // по той же позиции быть не должно.
  const click = h.slice(h.indexOf("container.addEventListener('click'"), h.indexOf('// Show real balances'));
  ok(/dispatchEvent\(new Event\('input'/.test(click), 'пересчёт идёт через событие поля');
  ok(!/previewLimitSell\(/.test(click), 'своего расчёта прибыли в обработчике нет');
  // Шаги стакана не трогаем: там лимит и стоп посчитаны вместе, и подпись
  // под полями собрана из них. Подменить один — рассогласовать пару.
  ok(!/sellStepsSave\(/.test(click), 'сохранённые шаги стакана не подменяются');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
