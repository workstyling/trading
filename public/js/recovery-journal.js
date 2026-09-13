(function (root) {
  'use strict';
  function renderRecoveryStatus(check) {
    const report = check && check.current && check.report;
    let message = 'Возврат — исторические частоты; свежая проверка ещё не завершена.';
    let color = '#f5c518';
    if (report && report.status === 'drift') {
      message = 'Свежая проверка: частоты расходятся с исторической сеткой. Проценты возврата не подтверждены.';
      color = '#ff6b6b';
    } else if (report && report.status === 'incomplete') {
      message = 'Свежая проверка неполная: для части процентов возврата мало наблюдений.';
    } else if (report && report.status === 'no-drift') {
      message = 'Свежая проверка: расхождений частот не обнаружено; прибыльность не проверялась.';
      color = 'var(--t2)';
    } else if (check && check.current && check.code !== 0) {
      message = 'Свежая проверка не завершилась; проценты возврата не подтверждены.';
    }
    if (report && check.at && Date.now() - check.at > 48 * 3600000) {
      message += ' Проверка старше двух суток.';
      if (report.status !== 'drift') color = '#f5c518';
    }
    return '<div style="font-size:10px;line-height:1.4;margin-bottom:6px;color:' + color + ';">' + message + '</div>';
  }
  function renderEntryJournal(pj) {
    const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
      notes.push(cell.label + ': прогноз при записи ' + (cell.promised ?? '—') +
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
      line += '<br><b>«Брать»: ' + esc(dec.state) + '</b> · ' + dec.haveN + '/' + dec.needN +
        ' исходов, ' + dec.haveHours + '/' + dec.needHours + ' общих ч';
      notes.push('Сейчас: ' + dec.why);
    }
    const left = pj.remeasure ? pj.remeasure.left : 0;
    if (left) line += ' · перепроверка свечей: осталось ' + left;
    if (overall && overall.hitUnknown) line += ' · неизвестен исход цели у ' + overall.hitUnknown + ' записей';
    return '<span title="' + esc(notes.filter(Boolean).join(NL)) + '">' + line + '</span>';
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { renderEntryJournal, renderRecoveryStatus };
  else Object.assign(root, { renderEntryJournal, renderRecoveryStatus });
})(typeof globalThis !== 'undefined' ? globalThis : this);
