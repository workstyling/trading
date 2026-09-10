// Список перерисовывался целиком каждые десять секунд: innerHTML менялся,
// потому что в нём живут цены, а они меняются всегда. Дерево уничтожалось и
// создавалось заново — отсюда моргание и «подгрузка» полосы, у которой в
// стилях стоит переход 0.3 с.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const h = fs.readFileSync('public/index.html', 'utf8');

// Крошечный DOM: узлы, атрибуты, дети. Больше правке на месте и не нужно.
function mkDoc() {
  const all = [];
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.attributes = []; this.childNodes = []; this._id = ''; all.push(this); }
    get id() { return this._id; }
    set id(v) { this._id = v; }
    setAttribute(n, v) {
      if (n === 'id') this._id = v;
      const a = this.attributes.find(x => x.name === n);
      if (a) a.value = v; else this.attributes.push({ name: n, value: v });
    }
    getAttribute(n) { const a = this.attributes.find(x => x.name === n); return a ? a.value : null; }
    removeAttribute(n) {
      if (n === 'id') this._id = '';
      this.attributes = this.attributes.filter(x => x.name !== n);
    }
    append(...kids) { for (const k of kids) this.childNodes.push(k); return this; }
    get children() { return this.childNodes.filter(c => c.nodeType !== 3); }
    hasAttribute(n) { return n === 'id' ? !!this._id : this.attributes.some(x => x.name === n); }
    getElementsByTagName() {
      const out = [];
      const walk = (el) => { for (const c of el.childNodes) if (c.nodeType !== 3) { out.push(c); walk(c); } };
      walk(this);
      return out;
    }
  }
  const txt = (v) => ({ nodeType: 3, nodeValue: v });
  const el = (tag, attrs = {}, kids = []) => {
    const e = new El(tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    e.append(...kids);
    return e;
  };
  return { El, txt, el };
}

const { txt, el } = mkDoc();
const ctx = { Set, console, document: { createElement: () => { throw new Error('не нужен'); } } };
vm.createContext(ctx);
for (const fn of ['function skeletonNodes', 'function sameSkeleton', 'function patchNode']) {
  const i = h.indexOf(fn);
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx);
}

console.log('\nКаркас сравнивается по строению');
{
  const a = el('div', {}, [el('span', { id: 'x' }, [txt('1')])]);
  const b = el('div', {}, [el('span', { id: 'x' }, [txt('2')])]);
  ok(ctx.sameSkeleton(a, b) === true, 'разные числа — каркас тот же');
  const c = el('div', {}, [el('span', { id: 'x' }), el('span', { id: 'y' })]);
  ok(ctx.sameSkeleton(a, c) === false, 'появился элемент — каркас другой');
  const d = el('div', {}, [el('b', { id: 'x' }, [txt('1')])]);
  ok(ctx.sameSkeleton(a, d) === false, 'сменился тег — каркас другой');
  // id важен: без него монеты могли бы «подмениться» местами
  const e2 = el('div', {}, [el('span', { id: 'z' }, [txt('1')])]);
  ok(ctx.sameSkeleton(a, e2) === false, 'сменился id — каркас другой');
}

console.log('\nПомеченное место не ломает сравнение');
{
  // В DOM внутри него живёт то, что дописал свой код; в разметке пусто.
  const live = el('span', { 'data-live': '1' }, [el('b', {}, [txt('−$10.23')])]);
  const a = el('div', {}, [el('span', { id: 'x' }, [txt('1')]), live]);
  const b = el('div', {}, [el('span', { id: 'x' }, [txt('2')]), el('span', { 'data-live': '1' }, [])]);
  ok(ctx.sameSkeleton(a, b) === true, 'внутрь помеченного не заглядываем — каркас сходится');
  ctx.patchNode(live, el('span', { 'data-live': '1', title: 'новое' }, []));
  ok(live.childNodes.length === 1, 'содержимое помеченного не затёрто');
  ok(live.getAttribute('title') === 'новое', 'а атрибуты обновлены');
  // Без пометки то же самое ломало бы сравнение — так и было в жизни
  const c = el('div', {}, [el('span', { id: 'x' }), el('span', {}, [el('b', {}, [txt('x')])])]);
  const d = el('div', {}, [el('span', { id: 'x' }), el('span', {}, [])]);
  ok(ctx.sameSkeleton(c, d) === false, 'без пометки лишний элемент рушит каркас — это и происходило');
}

console.log('\nПравка меняет только то, что изменилось');
{
  const oldEl = el('span', { style: 'left:10%', title: 'старое' }, [txt('−4.62')]);
  const newEl = el('span', { style: 'left:40%', title: 'новое' }, [txt('−6.66')]);
  ctx.patchNode(oldEl, newEl);
  ok(oldEl.getAttribute('style') === 'left:40%', 'стиль обновлён — полоса едет без пересборки');
  ok(oldEl.getAttribute('title') === 'новое', 'подсказка обновлена');
  ok(oldEl.childNodes[0].nodeValue === '−6.66', 'число обновлено');
  // Пропавший атрибут должен исчезнуть, иначе останется висеть старый стиль
  const o2 = el('span', { style: 'x', hidden: '1' }, []);
  ctx.patchNode(o2, el('span', { style: 'x' }, []));
  ok(o2.getAttribute('hidden') === null, 'исчезнувший атрибут снимается');
}

console.log('\nОбработчики не навешиваются повторно');
{
  ok(/if \(sel\.dataset\.wired\) return;/.test(h), 'выбор ордера навешивается один раз');
  ok((h.match(/dataset\.wired = '1';/g) || []).length >= 3, 'и остальные тоже',
    'мест: ' + (h.match(/dataset\.wired = '1';/g) || []).length);
  ok(/if \(container\.dataset\.wired\) return;/.test(h), 'полоса тоже');
}

console.log('\nДанные читаются заново, а не захватываются');
{
  const body = h.slice(h.indexOf('function calcHover'), h.indexOf('container.addEventListener(\'mousemove\''));
  // fee берётся из настроек вызовом getFeeMarket(), а не из атрибута:
  // это тоже чтение в момент расчёта, и настройка может смениться.
  for (const n of ['filled', 'spent', 'buyPrice', 'leftMax', 'rightMax']) {
    ok(new RegExp('const ' + n + ' = parseFloat\\(container\\.dataset').test(body),
      n + ' читается внутри расчёта — не устареет после частичной продажи');
  }
}

console.log('\nПолная замена осталась как запасной путь');
ok(/const fee = getFeeMarket\(\);/.test(h), 'комиссия читается из настроек в момент расчёта');
ok(/if \(!patched\) container\.innerHTML = h;/.test(h), 'когда каркас сменился — пересобираем');
ok(/try \{ return patchList\(container, h\); \} catch \{ return false; \}/.test(h),
  'сбой правки не оставляет экран старым, а откатывает к замене');


console.log('\nЖивые места пишутся без пересборки');
{
  // Наблюдение за DOM показало: строка стоп-лимита пересобиралась шесть раз
  // за двадцать пять секунд, счётчик свежести — каждую секунду. Каждое
  // присваивание innerHTML уничтожает вложенные узлы и создаёт заново, и это
  // видно глазом.
  ok(/function setLiveHtml\(el, html\)/.test(h), 'десктоп: помощник есть');
  ok(/if \(el\.innerHTML === html\) return;/.test(h),
    'ничего не изменилось — не трогаем вовсе');
  const body = h.slice(h.indexOf('function setLiveHtml'), h.indexOf('function refreshAfterTrade'));
  ok(/sameSkeleton\(el, tmp\)/.test(body), 'каркас сверяется');
  ok(/el\.innerHTML = html;/.test(body), 'и остаётся запасная полная замена');
  ok(body.indexOf('sameSkeleton') < body.lastIndexOf('el.innerHTML = html;'),
    'замена только после неудачной сверки');

  for (const [what, re] of [
    ['строка стоп-лимита', /setLiveHtml\(info, sellStepInfoHtml\(/],
    ['результат лимитки', /setLiveHtml\(el, '<b style="color:' \+ col/],
    ['счётчик свежести', /setLiveHtml\(el, agoTxt \+/],
  ]) ok(re.test(h), what + ' пишется через помощника');

  ok(!/info\.innerHTML = sellStepInfoHtml\(/.test(h), 'прямых присваиваний в этих местах не осталось');

  const m = fs.readFileSync('public/mobile/index.html', 'utf8');
  ok(/function setLiveHtmlM\(el, html\)/.test(m), 'мобильная: помощник есть');
  ok(/setLiveHtmlM\(info, sellStepInfoHtmlM\(/.test(m), 'и строка стоп-лимита идёт через него');
  ok(!/info\.innerHTML = sellStepInfoHtmlM\(/.test(m), 'прямых присваиваний нет');
}


console.log('\nТекст пишется без замены узла');
{
  // `el.textContent = x` выбрасывает существующие узлы и вставляет новый —
  // каждый раз, даже если строка та же. Наблюдатель за DOM показал по семь
  // таких замен на ячейку за двадцать пять секунд.
  const ctx2 = { String };
  vm.createContext(ctx2);
  const i = h.indexOf('function setText');
  vm.runInContext(h.slice(i, h.indexOf('\n    }', i) + 6), ctx2);
  const j = h.indexOf('function setClass');
  vm.runInContext(h.slice(j, h.indexOf('\n    }', j) + 6), ctx2);

  // Узел должен переиспользоваться, а не создаваться заново
  const node = { nodeType: 3, nodeValue: 'старое' };
  const el = { firstChild: node, childNodes: [node], textContent: null };
  ctx2.setText(el, 'новое');
  ok(node.nodeValue === 'новое', 'значение узла обновлено');
  ok(el.textContent === null, 'textContent не трогали — узел тот же');
  ctx2.setText(el, 'новое');
  ok(node.nodeValue === 'новое', 'повтор не вредит');

  // Если структура другая — честная замена
  const el2 = { firstChild: null, childNodes: [], textContent: null };
  ctx2.setText(el2, 'значение');
  ok(el2.textContent === 'значение', 'пустой элемент заполняется обычным способом');

  const el3 = { className: 'a' };
  ctx2.setClass(el3, 'a');
  ctx2.setClass(el3, 'b');
  ok(el3.className === 'b', 'класс меняется, когда отличается');

  for (const [what, re] of [
    ['лучший бид', /setText\(bidEl, '\$' \+ fmtPrice\(bestBid\)\)/],
    ['лучший ask', /setText\(askEl, '\$' \+ fmtPrice\(bestAsk\)\)/],
    ['прибыль по лимиту', /setText\(limitPnlEl,/],
    ['прибыль по рынку', /setLiveHtml\(pnlEl,/],
    ['отметка на полосе', /setText\(infoCurrent,/],
    ['позиция в очереди', /setText\(el, text\);/],
  ]) ok(re.test(h), what + ' пишется без замены узла');

  ok(!/el\.textContent = text;\n      el\.className = cls;/.test(h), 'прежней пары присваиваний не осталось');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
