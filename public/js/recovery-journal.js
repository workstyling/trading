(function (root) {
  'use strict';
  const finite = value => value != null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
  const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function freshRecoveryReport(check, now = Date.now()) {
    const r = check && check.current === true && check.report;
    const referenceAt = r && Date.parse(r.referenceDate);
    if (!r || r.version !== 2 || !['drift', 'incomplete', 'no-drift'].includes(r.status) ||
        check.code !== ({ drift: 1, incomplete: 2, 'no-drift': 0 })[r.status] ||
        !finite(check.at) || check.at > now + 60000 || now - check.at > 48 * 3600000 ||
        !Number.isFinite(referenceAt) || !finite(r.to) || !finite(r.from) ||
        r.from < referenceAt + 86400000 || r.from >= r.to || r.to > now + 60000 ||
        now - r.to > 48 * 3600000 || !Array.isArray(r.cells) ||
        !Array.isArray(r.missingCoins) || r.missingCoins.length) return null;
    return r;
  }
  const validCell = cell => cell && !cell.thin && finite(cell.actual) && cell.actual >= 0 && cell.actual <= 100 &&
    finite(cell.se) && cell.se >= 0 && finite(cell.coins) && cell.coins >= 12 ? cell : null;
  const fallBand = row => finite(row.dayFallPct) ? [10, 6, 3, 1, 0].find(value => Number(row.dayFallPct) >= value) : null;
  const freshReportFor = (scan, now) => {
    const report = freshRecoveryReport(scan.recheck, now);
    return report && report.referenceDate === scan.recoveryMeasuredAt ? report : null;
  };
  const scanNow = scan => finite(scan.serverNow) ? Number(scan.serverNow) : Date.now();
  function recoveryObservation(row, scan, now = finite(scan.serverNow) ? Number(scan.serverNow) : Date.now()) {
    const unknown = why => ({ hour: null, text: '—', color: 'var(--t2)', why });
    if (!finite(row.dayFallPct) || !finite(row.pullbackPct)) return unknown('Не хватает данных о падении или откате.');
    if (scan.staleSince || (finite(scan.at) && now - scan.at > 5 * 60000)) return unknown('Скан устарел; нужна свежая цена и условия отката.');
    const report = freshRecoveryReport(scan.recheck, now);
    if (!report || report.referenceDate !== scan.recoveryMeasuredAt) {
      return unknown('Свежей сопоставимой проверки нет. Исторический процент не используется как оценка.');
    }
    const lo = fallBand(row);
    const deep = row.pullbackPct >= 1.5;
    const cell = report.cells.find(c => c.lo === lo && c.deep === deep);
    if (!validCell(cell)) {
      // Прочерк без объяснения не отличить от поломки. Называем, чего именно
      // не хватает и почему это пройдёт: окно наблюдений начинается на сутки
      // позже исходного замера и растёт само. По истории такие клетки
      // набирают нужные 12 монет за 7-14 суток — при откате от 1.5% окна
      // редки, и за неполные четверо суток их набирается 0-8.
      const have = cell && finite(cell.coins) ? Number(cell.coins) : 0;
      const days = finite(report.from) && finite(report.to)
        ? Math.round((report.to - report.from) / 86400000 * 10) / 10 : null;
      return unknown('Недостаточно свежих наблюдений: монет ' + have + ' из 12' +
        (days == null ? '' : ', окно наблюдений ' + days + ' сут и растёт') +
        '. Клетки с откатом от 1.5% набирают нужное за 7-14 суток — до тех пор здесь прочерк, а не оценка.');
    }
    const hour = Math.round(cell.actual * 10) / 10;
    const period = new Date(report.from).toISOString().slice(0, 10) + ' — ' + new Date(report.to).toISOString().slice(0, 10);
    return { hour, se: Number(cell.se), text: hour.toFixed(1) + '%', color: 'var(--blue)',
      why: 'Свежая частота касания цели +0.30% за час: ' + hour.toFixed(1) +
        '% ±' + Number(cell.se).toFixed(1) + ' п.п. (1 стандартная ошибка); ' + cell.coins + ' монет' +
        (finite(cell.n) ? ', ' + cell.n + ' наблюдений' : '') + ', ' + period +
        '. Это наблюдение по группе, не вероятность прибыли этой монеты; комиссии и спред не вычтены.' };
  }
  // Базовая частота — клетка «падения почти нет, откат мелкий». Тот же замер,
  // то же окно, та же цель, но без условий панели: сравнивать строку больше не
  // с чем. Порог обязан приходить из того же измерения — своё число вместо
  // базы значило бы придумать разрешение на покупку.
  function recoveryBaseline(scan, now = scanNow(scan)) {
    const report = freshReportFor(scan, now);
    const cell = report && validCell(report.cells.find(c => c.lo === 0 && c.deep === false));
    return cell ? { pct: Math.round(cell.actual * 10) / 10, se: Number(cell.se) } : null;
  }
  // «Выше базы» значит, что группа чаще доходит до цели, чем монета, которая
  // никуда не падала. Правило то же, что у сторожа сетки: две ошибки разности
  // И не меньше трёх пунктов — иначе подсветка загорается от шума, а гореть
  // всё время значит не гореть вовсе.
  function recoveryEdge(observation, baseline) {
    if (!observation || observation.hour == null || !baseline) return { above: false, why: '' };
    const diff = Math.round((observation.hour - baseline.pct) * 10) / 10;
    const se = Math.sqrt(baseline.se * baseline.se + (finite(observation.se) ? observation.se * observation.se : 0));
    const above = diff > 2 * se && diff >= 3;
    return { above, diff, baseline: baseline.pct,
      why: 'База (падения почти нет) ' + baseline.pct.toFixed(1) + '%, здесь ' + observation.hour.toFixed(1) +
        '%: разница ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + ' п.п. при погрешности разности ' + se.toFixed(1) +
        (above
          ? '. Выше базы больше чем на две погрешности — до цели доходит чаще. Это не подтверждённая прибыль: комиссии и спред не вычтены.'
          : '. В пределах погрешности — не лучше монеты без падения.') };
  }
  // Порядок строк: сверху те, у кого измеренная частота выше.
  //
  // Первым ключом стоял уровень отката, а свежих наблюдений в глубоких
  // клетках пока нет — и верх списка занимали прочерки, тогда как 79% стояли
  // пятой строкой. Смотреть сверху вниз стало нельзя.
  //
  // Измеренные строки идут выше всех неизмеренных, а не вперемешку по
  // близкому числу: сверху должно стоять то, про что известно, чем оно
  // кончалось. Внутри — по самой частоте.
  //
  // Строки без своей оценки упорядочиваем между собой по известной мелкой
  // клетке того же падения: в историческом замере глубокий откат шёл не хуже
  // мелкого, так что это осторожная нижняя граница. На экран это число не
  // идёт — там остаётся прочерк, потому что своей оценки у клетки нет.
  const MEASURED_FIRST = 1000;
  function recoveryOrder(row, scan, verdict, observation, now = scanNow(scan)) {
    if (verdict && verdict.tier <= 1) return -1;
    // При равной частоте вперёд идёт более глубокий откат: в историческом
    // замере он добавлял 11-18 пунктов. Надбавка меньше десятой доли
    // процента, поэтому измеренную разницу она перебить не может.
    if (observation && observation.hour != null) {
      return MEASURED_FIRST + observation.hour +
        Math.min(Math.max(finite(row.pullbackPct) ? Number(row.pullbackPct) : 0, 0), 9) / 100;
    }
    const report = freshReportFor(scan, now);
    const band = fallBand(row);
    const near = report && band != null && validCell(report.cells.find(c => c.lo === band && c.deep === false));
    return near ? Math.round(Number(near.actual) * 10) / 10 : 0;
  }
  // Глубокий откат ушёл под черту: своей оценки у него нет, и измеренные
  // строки теперь выше. Выбросить его молча нельзя — до сегодняшнего дня он
  // стоял первым, а исторический замер давал ему 11-18 пунктов. Пропавшая
  // строка неотличима от строки, которой не было.
  function renderRecoveryDeepNote(sorted, shownCount, scan, now = scanNow(scan)) {
    const hidden = (sorted || []).slice(shownCount)
      .filter(row => finite(row.pullbackPct) && Number(row.pullbackPct) >= 1.5 &&
        recoveryObservation(row, scan, now).hour == null)
      .map(row => escapeHtml(String(row.coin).replace(/[^A-Z0-9]/gi, '')));
    if (!hidden.length) return '';
    return '<div style="font-size:10px;line-height:1.4;margin-top:5px;color:var(--t2);">' +
      'Ниже черты глубокий откат без свежей оценки: <b>' + hidden.slice(0, 6).join(', ') + '</b>' +
      (hidden.length > 6 ? ' и ещё ' + (hidden.length - 6) : '') +
      '. В историческом замере откат от 1.5% добавлял 11-18 пунктов, но свежих наблюдений в этих ' +
      'клетках пока нет — поэтому наверх они не подняты.</div>';
  }
  // ГЛАВНАЯ СТРОКА ПАНЕЛИ: что даёт покупка по этому списку после издержек.
  //
  // Частоту касания цели легко прочитать как обещание прибыли — особенно
  // когда строки отсортированы и подсвечены. Прогон по свечам говорит
  // обратное, и молчать об этом значит продавать список как список покупки.
  function renderRecoveryNet(scan) {
    const net = scan && scan.entryNet;
    if (!net || !finite(net.panel) || !finite(net.control) || !finite(net.modes) || !(net.modes > 0)) return '';
    const pct = v => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
    const okModes = Number(net.plusModes) || 0;
    const details = [
      'Прогон по свечам: вход по цене, выход по цели лимитом либо по цене в конце горизонта маркетом, стоп -3%.',
      'Комиссии учтены: мейкер 0.075%, тейкер 0.15%. Цель +0.30% равна круговому обороту тейкером — частота касания сама по себе не обещает ничего.',
      'Отбор: ' + pct(net.panel) + ' ±' + net.panelSe + ' за сделку на ' + net.n + ' входах.',
      'Случайный вход: ' + pct(net.control) + ' ±' + net.controlSe + ' на ' + net.controlN + '.',
      net.worst && finite(net.worst.diff)
        ? 'Хуже всего на длинном горизонте: ' + net.worst.horizonH + ' ч, цель ' + net.worst.target + '% — отбор ' +
          pct(net.worst.panel) + ' против ' + pct(net.worst.control) + ', разница ' + net.worst.diff + ' ±' + net.worst.se + ' п.п.'
        : '',
      'Это измерение периода, а не приговор правилу: исходная сетка мерилась на растущем рынке, здесь окно падающего.',
      'Пересчёт: node scripts/measure-net.js',
    ].filter(Boolean).join(String.fromCharCode(10));
    return '<div title="' + escapeHtml(details) + '" style="font-size:10px;line-height:1.45;margin-bottom:6px;' +
      'padding:5px 7px;border-radius:6px;background:rgba(255,107,107,0.10);border:1px solid rgba(255,107,107,0.35);' +
      'color:#ff9f9f;">' +
      '<b>Покупать по этому списку нельзя.</b> Прогон по свечам ' + escapeHtml(String(net.from)) + ' — ' +
      escapeHtml(String(net.to)) + ': отбор давал <b>' + pct(net.panel) + '</b> за сделку против <b>' +
      pct(net.control) + '</b> у случайного входа. Из ' + net.modes + ' режимов (горизонты 1/4/12/24 ч) ' +
      (okModes ? 'окупились ' + okModes : 'не окупился <b>ни один</b>') +
      '. Это список наблюдения, а не список покупки.</div>';
  }
  function renderRecoveryLegend(scan, now = scanNow(scan)) {
    const base = recoveryBaseline(scan, now);
    if (!base) return '';
    return '<div style="font-size:10px;line-height:1.4;margin-bottom:6px;color:var(--t2);">' +
      'Порог на экране: <b style="color:#00e5a0;">зелёным</b> — свежая частота цели выше базы <b>' +
      base.pct.toFixed(1) + '%</b> (монеты почти без падения) больше чем на две погрешности. ' +
      'Это «чаще доходит до цели», а не разрешение покупать: комиссии и спред не вычтены.</div>';
  }
  function recoveryVerdict(row, gate, observation) {
    const out = (tier, label, why, risk = false) => ({ tier, label, why,
      color: risk ? '#ff6b6b' : 'var(--t2)', bg: risk ? 'background:rgba(255,107,107,0.08);' : '' });
    if (!finite(row.chg24Pct) || !finite(row.pullbackPct)) return out(0, 'данные', 'Неизвестен ход за сутки или откат.');
    if (!finite(gate.fall) || !finite(gate.spread) || !finite(row.dayFallPct) || row.dayFallPct < gate.fall || !finite(row.spreadPct) ||
        row.spreadPct < 0 || row.spreadPct > gate.spread) return out(0, '—', 'Порог падения или спреда не пройден.');
    if (Math.abs(row.chg24Pct) >= 10) return out(1, 'риск', 'Ход за сутки от ±10%: повышенная амплитуда движения.', true);
    const tier = row.pullbackPct >= 1.5 ? 3 : 2;
    return observation.hour == null
      ? out(tier, 'нет оценки', observation.why)
      : out(tier, 'наблюдать', 'Условия отката выполнены. Прибыльность отбора не подтверждена; частота цели не разрешает покупку.');
  }
  function recoveryDayChange(row) {
    return finite(row.chg24Pct) ? (row.chg24Pct > 0 ? '+' : '') + Number(row.chg24Pct) + '%' : '—';
  }
  function renderRecoveryStatus(check, now = Date.now()) {
    const report = freshRecoveryReport(check, now);
    let message = 'Свежей оценки пока нет — вместо исторических процентов показан прочерк.';
    let color = '#f5c518';
    // Длина окна объясняет прочерки: чем оно короче, тем больше клеток пустых.
    const days = report && finite(report.from) && finite(report.to)
      ? Math.round((report.to - report.from) / 86400000 * 10) / 10 : null;
    const window = days == null ? '' : ' Окно наблюдений ' + days + ' сут и растёт.';
    if (report && report.status === 'drift') {
      message = 'Историческая сетка разошлась с проверкой. Показаны свежие наблюдения; где данных мало — прочерк.' + window;
    } else if (report && report.status === 'incomplete') {
      message = 'Свежие наблюдения: для части групп данных мало — показан прочерк.';
    } else if (report && report.status === 'no-drift') {
      message = 'Показана свежая частота цели за час; прибыльность отбора не подтверждена.';
      color = 'var(--t2)';
    } else if (check && check.current && check.code !== 0) {
      message = 'Свежая проверка не завершилась — оценка недоступна.';
    }
    return '<div style="font-size:10px;line-height:1.4;margin-bottom:6px;color:' + color + ';">' + message + '</div>';
  }
  function renderEntryJournal(pj) {
    const esc = escapeHtml;
    const num = value => value == null || !Number.isFinite(Number(value)) ? '—' :
      (Number(value) >= 0 ? '+' : '') + Number(value).toFixed(3) + '%';
    const NL = '\n';
    const c = pj.comparison;
    const dec = pj.decision;
    const overall = pj.overall;
    const notes = [
      'Изменение цены по закрытиям минутных свечей. Комиссии и спред не вычтены.',
      'Сравнение за общие часы с контрольной группой того же способа отбора.',
      '± — одна стандартная ошибка с учётом общего рынка и соседних часов. Это не 95%-интервал.',
      'Сравнение оценивает всё правило. Оно не доказывает пользу отдельного порога или прибыльность покупки.',
      pj.controlBasis ? 'Контроль: ' + pj.controlBasis : '',
    ];
    for (const [name, g] of Object.entries(pj.byVerdict || {})) {
      if (!g || !g.n) continue;
      notes.push(name + ': ' + g.m60n + '/' + g.n + ' известных исходов часа, ' + num(g.m60) +
        (g.m60seHour == null ? '' : ' ±' + g.m60seHour + ' п.п.') +
        '; у недошедших ' + num(g.m60NoHit) + '.');
    }
    for (const cell of pj.promiseVsFact || []) {
      if (!cell.n) continue;
      notes.push(cell.label + ': историческая сетка при записи ' + (cell.promised ?? '—') +
        '%, факт ' + (cell.actual ?? '—') + '%; исходов ' + cell.promisedN +
        ', неизвестно ' + cell.unknown + '.');
    }
    let line = '<b style="color:var(--t1);">Проверка вперёд:</b> ';
    if (c && c.n && c.controlN) {
      line += c.n + ' исходов и ' + c.controlN + ' контрольных за ' + c.hours + ' общих ч · ' +
        'через час <b>' + num(c.mainMean) + '</b> против <b>' + num(c.controlMean) + '</b>';
      if (c.diff != null) line += ' · разница ' + (c.diff >= 0 ? '+' : '') + c.diff +
        (c.se == null ? ' (погрешность неизвестна)' : ' ±' + c.se + ' п.п. (1SE)');
      if (c.hours < 25) line += ' · мало общих часов';
      else if (!c.significant) line += ' · в пределах погрешности';
      if (c.provisional) line += ' · предварительно';
    } else {
      line += 'сопоставимых исходов пока недостаточно; записано ' + (overall ? overall.n : 0) +
        ', в работе ' + (pj.open || 0);
    }
    line += ' · цена без издержек';
    if (dec) {
      line += '<br><b>Глубокий откат: ' + esc(dec.state) + '</b> · ' + dec.haveN + '/' + dec.needN +
        ' исходов, ' + dec.haveHours + '/' + dec.needHours + ' общих ч';
      notes.push('Сейчас: ' + dec.why);
    }
    const left = pj.remeasure ? pj.remeasure.left : 0;
    if (left) line += ' · перепроверка свечей: осталось ' + left;
    if (overall && overall.hitUnknown) line += ' · неизвестен исход цели у ' + overall.hitUnknown + ' записей';
    return '<span title="' + esc(notes.filter(Boolean).join(NL)) + '">' + line + '</span>';
  }
  const api = { renderEntryJournal, renderRecoveryStatus, renderRecoveryLegend, renderRecoveryNet, renderRecoveryDeepNote, recoveryObservation,
    recoveryVerdict, recoveryDayChange, recoveryBaseline, recoveryEdge, recoveryOrder,
    escapeRecoveryText: escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
