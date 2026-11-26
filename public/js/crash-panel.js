/**
 * Вкладка «Обвал и разворот»: монеты, которые сильно упали и начали расти.
 *
 * Код общий для обеих вёрсток — иначе телефон и компьютер со временем
 * показывают разное, а это здесь уже случалось.
 *
 * Правила измерены (85 036 событий, 289 монет, 133 дня, проверка на двух
 * половинах периода), и их цена тоже измерена: такие входы давали −0.21% за
 * сделку после комиссий. Поэтому панель называет находки находками, а не
 * сигналами к покупке, и показывает это число рядом со списком.
 */
(function (root) {
  'use strict';
  const finite = v => v != null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const price = v => !finite(v) ? '—' : Number(v) < 0.001 ? Number(v).toFixed(8)
    : Number(v) < 1 ? Number(v).toFixed(5) : Number(v) < 100 ? Number(v).toFixed(3) : Number(v).toFixed(2);
  const money = v => !finite(v) || Number(v) <= 0 ? '—' : Number(v) >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B'
    : Number(v) >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + Math.round(v / 1e3) + 'K';

  function ago(at, now) {
    if (!finite(at) || !(Number(at) > 0)) return 'ещё не было';
    const sec = Math.max(0, Math.round((now - Number(at)) / 1000));
    return sec < 60 ? sec + ' с назад' : sec < 3600 ? Math.round(sec / 60) + ' мин назад' : Math.round(sec / 3600) + ' ч назад';
  }
  // Когда ждать следующий проход. Без этого непонятно, живой список или
  // застывший, и приходится гадать, нажимать ли «Обновить».
  function nextIn(at, intervalMs, now) {
    if (!finite(at) || !(Number(at) > 0) || !finite(intervalMs)) return '';
    const left = Number(at) + Number(intervalMs) - now;
    if (left <= 0) return 'обновление вот-вот';
    const min = Math.floor(left / 60000), sec = Math.round((left % 60000) / 1000);
    return 'следующий через ' + (min > 0 ? min + ' мин ' + sec + ' с' : sec + ' с');
  }

  // ГРАФИК СВЕРХУ ВКЛАДКИ. Один кадр на всю вкладку, а не свой в каждой
  // карточке: два десятка кадров вешают телефон, а смотреть всё равно
  // приходится по одному. Выбранная монета помнится между обновлениями
  // списка, иначе график пропадал бы раз в минуту.
  let chartCoin = '';
  const safeCoin = v => String(v || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  function crashChartCoin() { return chartCoin; }

  function renderCrashChart() {
    if (!chartCoin) return '';
    return '<div data-crash-chart style="margin:6px 0;padding:6px;border:1px solid var(--b1);border-radius:8px;background:var(--s1);">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
      '<b style="color:var(--t0);font-size:12px;">' + chartCoin + ' · 15 минут</b>' +
      '<a href="https://www.tradingview.com/chart/?symbol=COINBASE%3A' + chartCoin + 'USD" target="_blank" rel="noopener" ' +
      'style="color:var(--blue);font-size:10px;">открыть на TradingView ↗</a>' +
      '<button onclick="crashCloseChart()" title="Закрыть график" ' +
      'style="margin-left:auto;padding:0 9px;min-height:26px;font-size:11px;font-weight:700;line-height:1;cursor:pointer;' +
      'border-radius:6px;border:1px solid var(--b1);background:transparent;color:var(--t2);">✕</button></div>' +
      '<iframe title="График ' + chartCoin + '" ' +
      'src="https://s.tradingview.com/widgetembed/?symbol=COINBASE%3A' + chartCoin +
      'USD&interval=15&theme=dark&style=1&timezone=exchange&hide_top_toolbar=1&hide_legend=1&hide_side_toolbar=1&save_image=0" ' +
      'style="width:100%;height:300px;border:0;border-radius:6px;display:block;" frameborder="0" allowtransparency="true" scrolling="no"></iframe>' +
      '</div>';
  }

  // Выбор монеты: ставим график сверху и прокручиваем к нему, иначе на
  // телефоне он остаётся выше экрана и кажется, что ничего не произошло.
  function crashShowChart(coin, repaint) {
    const safe = safeCoin(coin);
    if (!safe) return;
    chartCoin = safe;
    if (typeof repaint === 'function') repaint();
    if (typeof document === 'undefined') return;
    const box = document.querySelector('[data-crash-chart]');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function crashCloseChartState(repaint) {
    chartCoin = '';
    if (typeof repaint === 'function') repaint();
  }

  // Шапка: состояние прохода, выключатель отчётов и измеренная цена вопроса.
  function renderCrashHead(data, onToggle, onRefresh) {
    const now = finite(data.serverNow) ? Number(data.serverNow) : Date.now();
    const m = data.measure || {};
    const f = m.filtered || {};
    const state = data.running ? 'идёт проход…'
      : data.error ? '<span style="color:#ff6b6b;">сбой: ' + esc(data.error) + '</span>'
        : 'проверено ' + (data.coins || 0) + ' монет · ' + ago(data.at, now) +
          (nextIn(data.at, data.intervalMs, now) ? ' · ' + nextIn(data.at, data.intervalMs, now) : '');
    const alertBtn = '<button data-crash-alert onclick="' + onToggle + '" ' +
      'title="' + (data.alertOn ? 'Выключить отчёты в Telegram' : 'Присылать отчёт в Telegram по каждой новой находке') +
      '. Одна монета — один отчёт, пока она не уйдёт из списка." ' +
      'style="padding:0 10px;min-height:28px;font-size:11px;font-weight:700;line-height:1;cursor:pointer;' +
      'border-radius:7px;white-space:nowrap;border:1px solid ' + (data.alertOn ? '#00e5a0' : 'var(--b1)') + ';' +
      'background:' + (data.alertOn ? 'rgba(0,229,160,0.14)' : 'transparent') + ';' +
      'color:' + (data.alertOn ? '#00e5a0' : 'var(--t2)') + ';">' +
      (data.alertOn ? '🔔 Отчёты включены' : '🔕 Отчёты выключены') + '</button>';
    const refreshBtn = '<button onclick="' + onRefresh + '" title="Запустить проход прямо сейчас" ' +
      'style="padding:0 10px;min-height:28px;font-size:11px;font-weight:700;line-height:1;cursor:pointer;' +
      'border-radius:7px;border:1px solid var(--b1);background:transparent;color:var(--t2);">↻ Обновить</button>';
    const warn = data.tgConfigured === false
      ? '<div style="color:#ff6b6b;font-size:10px;margin-top:4px;">Telegram не настроен — отчёты не уйдут.</div>' : '';
    // Цена вопроса стоит в шапке, а не в сноске: без неё список читается как
    // список для покупки, а замер этого не подтверждает.
    const cost = finite(f.netPct)
      ? '<div style="margin-top:6px;padding:5px 7px;border-radius:6px;font-size:10px;line-height:1.45;' +
        'background:rgba(255,107,107,0.10);border:1px solid rgba(255,107,107,0.35);color:#ff9f9f;">' +
        '<b>Это находки для разбора, а не сигналы к покупке.</b> На замере ' +
        esc(m.events) + ' событий по ' + esc(m.coins) + ' монетам (' + esc(m.from) + ' — ' + esc(m.to) +
        ') такие входы давали <b>' + f.netPct + '% ±' + f.netSe + '</b> за сделку после комиссий, в плюсе ' +
        f.winPct + '%. Прибыльных сочетаний цели и срока: ' + m.profitableModes + ' из ' + m.modesChecked + '.' +
        '</div>' : '';
    return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
      '<b style="color:var(--t0);font-size:13px;">📉➚ Обвал и разворот</b>' +
      '<span style="color:var(--t2);font-size:10px;">' + state + '</span>' +
      '<span style="margin-left:auto;display:flex;gap:6px;">' + refreshBtn + alertBtn + '</span></div>' +
      warn + cost;
  }

  // Правила — свёрнуты: они длинные, но должны быть доступны целиком.
  function renderCrashRules(data) {
    const m = data.measure || {};
    return '<details style="margin-top:6px;font-size:10px;color:var(--t2);">' +
      '<summary style="cursor:pointer;">Как ищем и почему именно так</summary>' +
      '<div style="padding:5px 0;line-height:1.5;">' +
      'Каждые 10 минут проверяются все монеты Coinbase с оборотом от $50K. Сначала по суточной статистике ' +
      'отбираются те, кто заметно ниже суточного максимума и недалеко от дна, затем по часовым свечам считаются восемь условий.<br>' +
      '<b>Условия взяты из замера</b> ' + esc(m.events) + ' событий по ' + esc(m.coins) + ' монетам за ' +
      esc(m.from) + ' — ' + esc(m.to) + '. Каждое подтверждено на двух половинах периода отдельно: ' +
      'признак, работавший только на одной, отброшен.<br>' +
      '<b>Что отброшено:</b> глубина падения сама по себе, всплеск объёма, более высокое дно, рост три часа подряд, ' +
      'выход выше EMA50 (оказался даже вредным).<br>' +
      '<b>Чего правила не дают:</b> прибыли. Ни одна цель от +2% до +10% и ни один срок от 6 до 48 часов ' +
      'не вышли в плюс после комиссий. Фильтры поднимают результат с ' + (m.all ? m.all.netPct + '%' : '−0.9%') +
      ' до ' + (m.filtered ? m.filtered.netPct + '%' : '−0.2%') + ' — то есть убирают худшее, но не делают сделку выгодной.' +
      '</div></details>';
  }

  function renderCrashRows(data) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      return '<div style="margin-top:8px;color:var(--t2);font-size:11px;">' +
        (data.running ? 'Идёт первый проход, подождите минуту.' : 'Пока ничего не найдено: сильно упавших монет с разворотом сейчас нет.') +
        '</div>';
    }
    return '<div style="margin-top:8px;">' + rows.map(r => {
      const safe = String(r.coin).replace(/[^A-Z0-9]/gi, '');
      const colour = r.ready ? '#00e5a0' : r.done >= r.total - 1 ? '#f5c518' : 'var(--t2)';
      const checks = (r.checks || []).map(c =>
        '<div title="' + esc(c.why) + '" style="display:flex;gap:6px;padding:1px 0;">' +
        '<span style="color:' + (c.ok ? 'var(--green)' : '#ff6b6b') + ';">' + (c.ok ? '✓' : '✗') + '</span>' +
        '<span style="color:var(--t2);">' + esc(c.k) + '</span>' +
        '<span style="margin-left:auto;color:' + (c.ok ? 'var(--t1)' : '#ff9f9f') + ';white-space:nowrap;">' +
        esc(c.v) + '</span></div>').join('');
      const picked = safe === chartCoin;
      return '<details style="margin-bottom:6px;border:1px solid ' +
        (picked ? 'var(--blue)' : r.ready ? 'rgba(0,229,160,0.4)' : 'var(--b1)') +
        ';border-radius:8px;padding:6px 8px;' + (r.ready ? 'background:rgba(0,229,160,0.06);' : '') + '">' +
        '<summary title="Нажмите, чтобы раскрыть условия" ' +
        'style="cursor:pointer;display:flex;align-items:center;gap:7px;flex-wrap:wrap;">' +
        '<b onclick="event.preventDefault();event.stopPropagation();crashOpenChart(\'' + safe + '\')" ' +
        'title="Показать график ' + safe + ' сверху" ' +
        'style="color:' + (picked ? 'var(--blue)' : 'var(--t0)') + ';font-size:12px;cursor:pointer;' +
        'text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;">' + safe + '</b>' +
        '<span style="color:var(--t2);font-size:10px;">$' + price(r.price) + '</span>' +
        '<span style="color:#ff6b6b;font-size:11px;font-weight:700;">−' + r.fall + '%</span>' +
        '<span style="color:var(--green);font-size:11px;font-weight:700;">от дна +' + r.rise + '%</span>' +
        '<span style="color:' + colour + ';font-size:11px;font-weight:800;margin-left:auto;">' +
        r.done + '/' + r.total + (r.ready ? ' ✓' : '') + '</span>' +
        // Ликвидность рядом с монетой: по упавшей монете это первый вопрос —
        // есть ли кому продать. Глубина ±2% показывает, сколько денег стоит
        // по обе стороны от цены.
        '<span style="flex-basis:100%;color:var(--t2);font-size:9.5px;display:flex;gap:8px;flex-wrap:wrap;">' +
        '<span title="Оборот пары к USD на Coinbase за 24 часа">Vol24 ' + money(r.vol24) + '</span>' +
        '<span title="Капитализация из каталога Coinbase. Прочерк — не найдена или тикер принадлежит другому проекту">MCap ' +
        money(r.mcap) + '</span>' +
        '<span title="Глубина стакана в пределах 2% от цены: слева деньги покупателей, справа — продавцов. Прочерк — стакан не получен">±2% ' +
        (r.depth ? '<b style="color:var(--green);">' + money(r.depth.bid) + '</b>/<b style="color:#ff6b6b;">' + money(r.depth.ask) + '</b>' : '—') +
        '</span></span>' +
        '</summary>' +
        '<div style="margin-top:4px;font-size:10px;">' +
        '<div style="color:var(--t2);margin-bottom:3px;">дно ' + r.sinceLow + ' ч назад · RSI ' +
        (r.rsi == null ? '—' : r.rsi) + ' · объём ' + (r.volFading == null ? '—' : r.volFading + '× от дна') +
        ' · за сутки ' + (r.d24 == null ? '—' : (r.d24 > 0 ? '+' : '') + r.d24 + '%') +
        '</div>' + checks +
        '<div style="margin-top:4px;"><button onclick="crashOpenChart(\'' + safe + '\')" ' +
        'style="padding:0 9px;min-height:26px;font-size:10px;font-weight:700;line-height:1;cursor:pointer;' +
        'border-radius:6px;border:1px solid var(--blue);background:rgba(0,180,255,0.12);color:var(--blue);">' +
        '📈 График ' + safe + '</button></div>' +
        '</div></details>';
    }).join('') + '</div>';
  }

  function renderCrashPanel(data, onToggle, onRefresh) {
    if (!data || data.success === false) {
      return '<div style="color:var(--t2);font-size:11px;">Поиск обвалов недоступен' +
        (data && data.error ? ': ' + esc(data.error) : '.') + '</div>';
    }
    // График идёт сразу под шапкой — выше списка, чтобы не искать его.
    return renderCrashHead(data, onToggle, onRefresh) + renderCrashChart() +
      renderCrashRules(data) + renderCrashRows(data);
  }

  // Список обновляется сам раз в минуту. Без этого раскрытая карточка с
  // графиком схлопывалась бы при каждом обновлении, и смотреть график было бы
  // невозможно: он успевал бы прожить меньше минуты.
  function crashOpenCoins(root) {
    const out = [];
    if (!root) return out;
    root.querySelectorAll('details[ontoggle]').forEach(d => {
      const coin = (d.querySelector('b') || {}).textContent;
      if (d.open && coin) out.push(coin.trim());
    });
    return out;
  }
  function crashRestoreOpen(root, coins) {
    if (!root || !coins || !coins.length) return;
    root.querySelectorAll('details[ontoggle]').forEach(d => {
      const coin = (d.querySelector('b') || {}).textContent;
      if (coin && coins.includes(coin.trim())) {
        d.open = true;
        const m = /crashChart\(this, '([A-Z0-9]+)'\)/.exec(d.getAttribute('ontoggle') || '');
        if (m) crashChart(d, m[1]);
      }
    });
  }

  const api = { renderCrashPanel, renderCrashHead, renderCrashRules, renderCrashRows,
    renderCrashChart, crashShowChart, crashCloseChartState, crashChartCoin,
    nextIn, crashOpenCoins, crashRestoreOpen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
