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
  function recoveryObservation(row, scan, now = finite(scan.serverNow) ? Number(scan.serverNow) : Date.now()) {
    const unknown = why => ({ hour: null, text: '—', color: 'var(--t2)', why });
    if (!finite(row.dayFallPct) || !finite(row.pullbackPct)) return unknown('Не хватает данных о падении или откате.');
    if (scan.staleSince || (finite(scan.at) && now - scan.at > 5 * 60000)) return unknown('Скан устарел; нужна свежая цена и условия отката.');
    const report = freshRecoveryReport(scan.recheck, now);
    if (!report || report.referenceDate !== scan.recoveryMeasuredAt) {
      return unknown('Свежей сопоставимой проверки нет. Исторический процент не используется как оценка.');
    }
    const lo = [10, 6, 3, 1, 0].find(value => row.dayFallPct >= value);
    const deep = row.pullbackPct >= 1.5;
    const cell = report.cells.find(c => c.lo === lo && c.deep === deep);
    if (!cell || cell.thin || !finite(cell.actual) || cell.actual < 0 || cell.actual > 100 ||
        !finite(cell.se) || cell.se < 0 || !finite(cell.coins) || cell.coins < 12) {
      return unknown('Для этой глубины падения и отката недостаточно свежих наблюдений.');
    }
    const hour = Math.round(cell.actual * 10) / 10;
    const period = new Date(report.from).toISOString().slice(0, 10) + ' — ' + new Date(report.to).toISOString().slice(0, 10);
    return { hour, text: hour.toFixed(1) + '%', color: 'var(--blue)',
      why: 'Свежая частота касания цели +0.30% за час: ' + hour.toFixed(1) +
        '% ±' + Number(cell.se).toFixed(1) + ' п.п. (1 стандартная ошибка); ' + cell.coins + ' монет' +
        (finite(cell.n) ? ', ' + cell.n + ' наблюдений' : '') + ', ' + period +
        '. Это наблюдение по группе, не вероятность прибыли этой монеты; комиссии и спред не вычтены.' };
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
    if (report && report.status === 'drift') {
      message = 'Историческая сетка разошлась с проверкой. Показаны свежие наблюдения; где данных мало — прочерк.';
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
  const api = { renderEntryJournal, renderRecoveryStatus, recoveryObservation, recoveryVerdict, recoveryDayChange, escapeRecoveryText: escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
