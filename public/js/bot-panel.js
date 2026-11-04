// Раздел Trading bot. Общий для обеих вёрсток: разметка у каждой своя, а id
// элементов совпадают. Разбивку на сделки считает сервер, здесь только показ.
(function () {
  const POLL_MS = 15000;
  const $ = (id) => document.getElementById(id);
  const usd = (v) => '$' + Number(v).toFixed(2);
  const isVisible = () => { const root = $('botRoot'); return !!root && root.offsetParent !== null; };
  let requestSeq = 0;

  function setDisabled(el, disabled) {
    el.disabled = disabled;
    el.style.opacity = disabled ? '0.45' : '';
    el.style.cursor = disabled ? 'not-allowed' : '';
  }

  function setMessage(text) {
    const el = $('botMsg');
    el.textContent = text || '';
    el.style.display = text ? '' : 'none';
  }

  function renderCoins(view) {
    const select = $('botCoin');
    if (document.activeElement === select) return;
    const coins = view.coins.includes(view.coin) ? view.coins : [view.coin, ...view.coins];
    const same = select.options.length === coins.length &&
      coins.every((coin, i) => select.options[i].value === coin);
    if (!same) {
      select.replaceChildren(...coins.map((coin) => {
        const option = document.createElement('option');
        option.value = coin;
        option.textContent = coin;
        return option;
      }));
    }
    select.value = view.coin;
  }

  function setField(el, value) {
    if (document.activeElement !== el) el.value = value;
  }

  function planText(view) {
    if (view.plan === null) return 'Баланс неизвестен: разбивку посчитать нельзя.';
    const balance = (view.mode === 'test' ? 'Тестовый баланс ' : 'Баланс ') + usd(view.balance);
    if (!view.plan.length) {
      return balance + ': меньше минимальной сделки ' + usd(view.minDealUsd) + '.';
    }
    const deals = view.plan.map((sum, i) => 'сделка ' + (i + 1) + ': ' + usd(sum)).join(', ');
    const rest = view.balance - view.plan.reduce((a, b) => a + b, 0);
    return balance + ' → ' + deals + (rest >= 0.01 ? '. Останется ' + usd(rest) : '') + '.' +
      (view.lockedUsd > 0 ? ' Сейчас в сделках ' + usd(view.lockedUsd) + '.' : '');
  }

  const pct = (v) => Number(v).toFixed(2) + '%';

  function feesText(view) {
    const fees = view.fees;
    if (!fees) return 'Комиссии неизвестны.';
    let text = 'Объём за 30 дней ' + usd(fees.volumeUsd) + (fees.tier ? ', тариф ' + fees.tier : '') +
      '. Комиссия: Limit ' + pct(fees.limitPct) + ', Market ' + pct(fees.marketPct) +
      '. Купить и продать в ноль: Limit +' + pct(fees.limitBreakevenPct) +
      ', Market +' + pct(fees.marketBreakevenPct) + '.';
    if (view.plan && view.plan.length) {
      const deal = view.plan[0];
      text += ' На сделку ' + usd(deal) + ': Limit ' + usd(deal * fees.limitPct * 2 / 100) +
        ', Market ' + usd(deal * fees.marketPct * 2 / 100) + '.';
    }
    return text;
  }

  function orderTypesText(view) {
    const types = view.orderTypes;
    if (!types) return 'Тип ордера не выбран: не хватает данных.';
    const isLimit = types.entry === 'limit';
    return 'Ордера: вход и фиксация прибыли ' + (isLimit ? 'Limit' : 'Market') +
      ', дешевле ' + (isLimit ? 'Market' : 'Limit') + ' на ' + pct(types.savingPct) + ' за сторону ' +
      (types.spreadKnown ? 'с учётом спреда' : 'без учёта спреда') +
      '. Стоп Market: выйти важнее цены.';
  }

  function renderDirection(view) {
    const el = $('botDirection');
    const direction = view.direction;
    if (!direction) {
      el.textContent = 'Направление ' + view.coin + ' неизвестно.';
      return;
    }
    const looks = {
      up: ['вверх', 'var(--green)'],
      down: ['вниз', 'var(--red)'],
      sideways: ['боком', 'var(--t1)'],
    };
    const [word, color] = looks[direction.trend];
    const label = document.createElement('b');
    label.textContent = word;
    label.style.color = color;
    const change = direction.change24hPct == null ? '' :
      ' За 24 ч ' + (direction.change24hPct >= 0 ? '+' : '') + pct(direction.change24hPct) + '.';
    el.replaceChildren('Сейчас ' + view.coin + ' (1 ч): ', label, '.' + change + ' Это текущий тренд, не прогноз.');
  }

  // Цвет через important: в мобильной вёрстке глобальные стили кнопок заданы так же.
  function renderMode(view) {
    const buttons = [['real', 'botModeReal', 'var(--green)'], ['test', 'botModeTest', 'var(--blue)']];
    for (const [mode, id, color] of buttons) {
      const button = $(id);
      const active = view.mode === mode;
      setDisabled(button, view.status !== 'stopped');
      if (active) button.style.opacity = '';
      button.setAttribute('aria-pressed', String(active));
      button.style.setProperty('color', active ? color : 'var(--t2)', 'important');
      button.style.setProperty('border-color', active ? color : 'var(--b1)', 'important');
    }
  }

  const CLOSE_REASONS = {
    takeProfit: 'Цель', stopLoss: 'Стоп', timeExit: 'По времени', stopButton: 'Кнопка Стоп',
  };
  const typeName = (type) => (type === 'limit' ? 'Limit' : 'Market');

  const moneyOrDash = (v) => (Number.isFinite(v) ? usd(v) : '—');

  function price(v) {
    if (!Number.isFinite(v)) return '—';
    if (v >= 100) return '$' + v.toFixed(2);
    return '$' + v.toFixed(v >= 1 ? 4 : 8);
  }

  // Плюс зелёный, минус красный, ноль нейтральный.
  function setProfit(el, value) {
    if (!Number.isFinite(value)) {
      el.textContent = '—';
      el.style.color = 'var(--t2)';
      return;
    }
    const cents = Math.round(value * 100);
    el.textContent = (cents > 0 ? '+' : cents < 0 ? '−' : '') + usd(Math.abs(value));
    el.style.color = cents > 0 ? 'var(--green)' : cents < 0 ? 'var(--red)' : 'var(--t2)';
  }

  // Каждая строка таблицы: массив текстов, последняя ячейка — профит.
  function fillTable(body, rows, columns, emptyText) {
    if (!rows.length) {
      const cell = document.createElement('td');
      cell.colSpan = columns;
      cell.textContent = emptyText;
      cell.style.textAlign = 'center';
      cell.style.padding = '14px 8px';
      cell.style.color = 'var(--t2)';
      const row = document.createElement('tr');
      row.append(cell);
      body.replaceChildren(row);
      return;
    }
    body.replaceChildren(...rows.map(({ cells, profit }) => {
      const row = document.createElement('tr');
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        cell.style.padding = '6px 8px';
        row.append(cell);
      }
      const cell = document.createElement('td');
      cell.style.padding = '6px 8px';
      cell.style.fontWeight = '700';
      setProfit(cell, profit);
      row.append(cell);
      return row;
    }));
  }

  // Что из пары продажи работает сейчас. Пока покупка не исполнена, продавать нечего.
  function sellLeg(order) {
    if (!order) return 'после покупки';
    return typeName(order.type) + ' ' + price(order.price) + ', ' +
      (order.status === 'OPEN' ? 'работает' : 'ждёт цену');
  }

  function openDealRow(deal) {
    return {
      cells: [
        new Date(deal.buy.at).toLocaleString(),
        deal.pair,
        typeName(deal.buy.type) + ', ' + (deal.buy.status === 'FILLED' ? 'исполнена' : 'ждёт исполнения'),
        price(deal.buy.price),
        moneyOrDash(deal.buy.usd),
        moneyOrDash(deal.buyFeeUsd),
        sellLeg(deal.target),
        sellLeg(deal.stop),
      ],
      profit: deal.nowNetUsd,
    };
  }

  function closedDealRow(deal) {
    return {
      cells: [
        new Date(deal.closedAt).toLocaleString(),
        deal.pair,
        typeName(deal.buy.type) + ' ' + price(deal.buy.price),
        typeName(deal.sell.type) + ' ' + price(deal.sell.price),
        CLOSE_REASONS[deal.sell.role] || deal.sell.role,
        moneyOrDash(deal.buy.usd),
        moneyOrDash(deal.sell.usd),
        moneyOrDash(deal.feesUsd),
      ],
      profit: deal.netUsd,
    };
  }

  function renderDeals(view) {
    fillTable($('botOpenDeals'), view.deals.open.map(openDealRow), 9, 'Открытых сделок нет.');
    fillTable($('botClosedDeals'), view.deals.closed.map(closedDealRow), 9, 'Закрытых сделок пока нет.');
    setProfit($('botNetProfit'), view.netProfitUsd);
    $('botFeesPaid').textContent = usd(view.paidFeesUsd);
    const cancelled = view.deals.cancelledEntries;
    const note = $('botCancelled');
    note.textContent = cancelled ? 'Снято входов без сделки: ' + cancelled + '. Денег и комиссий они не тронули.' : '';
    note.style.display = cancelled ? '' : 'none';
  }

  function render(view) {
    const looks = {
      running: ['Запущен', 'var(--green)'],
      paused: ['Пауза', 'var(--yellow)'],
      stopped: ['Остановлен', 'var(--t2)'],
    };
    const [statusText, statusColor] = looks[view.status];
    const status = $('botStatus');
    status.textContent = statusText;
    status.style.color = statusColor;
    const locked = view.status !== 'stopped';
    renderMode(view);
    renderCoins(view);
    setField($('botMaxDeals'), view.maxDeals);
    setField($('botMaxUsd'), view.maxUsd);
    for (const id of ['botCoin', 'botMaxDeals', 'botMaxUsd']) setDisabled($(id), locked);
    document.querySelectorAll('#botRoot .bot-step').forEach((button) => setDisabled(button, locked));
    setDisabled($('botStart'), view.status === 'running');
    setDisabled($('botPause'), view.status !== 'running');
    setDisabled($('botStop'), view.status === 'stopped');
    $('botPlan').textContent = planText(view);
    $('botFees').textContent = feesText(view);
    $('botOrderTypes').textContent = orderTypesText(view);
    renderDirection(view);
    $('botNote').textContent = (view.nextEntryAt
      ? 'Следующий вход не раньше ' + new Date(view.nextEntryAt).toLocaleTimeString() + '. '
      : '') + (view.note || '');
    renderDeals(view);
  }

  // Состояние неизвестно: запускать нельзя.
  function renderUnknown() {
    $('botStatus').textContent = 'Нет связи';
    $('botStatus').style.color = 'var(--t2)';
    setDisabled($('botStart'), true);
    $('botPlan').textContent = 'Нет связи с сервером: разбивка неизвестна.';
  }

  // Ответ на устаревший запрос отбрасываем, чтобы опрос не затёр результат нажатия.
  async function request(url, options) {
    const seq = ++requestSeq;
    let view = null;
    try {
      const response = await fetch(url, options);
      view = await response.json();
    } catch (e) {
      view = { success: false, error: 'Нет связи с сервером' };
    }
    return seq === requestSeq ? view : null;
  }

  async function load() {
    if (!$('botRoot')) return;
    const view = await request('/api/bot');
    if (!view) return;
    if (view.success) render(view);
    else renderUnknown();
  }

  function post(path, payload) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
  }

  async function act(path, payload) {
    setMessage('');
    const view = await post(path, payload);
    if (!view) return;
    if (view.success) { render(view); return; }
    setMessage(view.error || 'Ошибка');
    await load();
  }

  window.botLoad = load;
  window.botSaveConfig = () => act('/api/bot/config', {
    coin: $('botCoin').value,
    maxDeals: $('botMaxDeals').value,
    maxUsd: $('botMaxUsd').value,
  });
  // Кнопки − и + у числовых полей. Значение держим в границах min и max поля.
  window.botStep = (id, delta) => {
    const input = $(id);
    const min = Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    const current = input.value === '' ? min : Number(input.value);
    if (!Number.isFinite(current)) return;
    const next = Math.min(max, Math.max(min, current + delta));
    if (next === current) return;
    input.value = next;
    window.botSaveConfig();
  };
  window.botSetMode = (mode) => act('/api/bot/mode', { mode });
  window.botOnStart = () => act('/api/bot/start');
  window.botOnPause = () => act('/api/bot/pause');
  window.botOnStop = () => act('/api/bot/stop');

  // Опрос заодно убирает старое сообщение: поле к этому времени уже вернулось
  // к сохранённому значению.
  setInterval(() => {
    if (!isVisible() || document.hidden) return;
    setMessage('');
    load();
  }, POLL_MS);
})();
