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
        !Array.isArray(r.missingCoins) || r.missingCoins.length > missingAllowed(r)) return null;
    return r;
  }
  // СКОЛЬКО НЕДОКАЧАННЫХ МОНЕТ ОТЧЁТ ЕЩЁ ПЕРЕЖИВАЕТ.
  //
  // Прежде не переживал ни одной: любое имя в «не докачалось» обнуляло весь
  // отчёт, и панель ставила прочерк всем монетам сразу. Так и вышло — из-за
  // одного USD1, стейблкоина, которого в скане нет вовсе, панель осталась без
  // оценок на 52 монетах, при том что в мелких клетках было по одиннадцать
  // тысяч наблюдений на полусотне монет.
  //
  // Недокачанная монета просто не попадает в выборку, а достаточность каждой
  // клетки и без того проверяется отдельно: не меньше двенадцати монет в ней.
  // Поэтому единичные пропуски терпим, а массовый сбой загрузки — нет: там
  // отчёт уже не про ту совокупность, о которой думаешь.
  //
  // Размер корзины отчёт называет сам. Если не назвал — держимся прежней
  // строгости: допуск в долях от неизвестного числа это не допуск.
  const missingAllowed = report =>
    finite(report.coins) ? Math.max(2, Math.round(Number(report.coins) * 0.1)) : 0;
  // Столько же наблюдений требует и сам замер, прежде чем считать монету.
  const MIN_COIN_POINTS = 30;
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
        '. Нужны минимум 12 монет с 30 наблюдениями в этой группе; срок накопления заранее неизвестен.');
    }
    const groupPct = Math.round(cell.actual * 10) / 10;
    const period = new Date(report.from).toISOString().slice(0, 10) + ' — ' + new Date(report.to).toISOString().slice(0, 10);
    // ЧИСЛО САМОЙ МОНЕТЫ, ЕСЛИ ОНО ЕСТЬ.
    //
    // Среднее по клетке про отдельную монету не говорит почти ничего: при
    // ошибке клетки ±2 п.п. разброс внутри неё — от 22% (BTC) до 91%
    // (USELESS). Показывать BTC семьдесят процентов значит завышать втрое.
    // Сюда же упирался вопрос «почему таблица не различает монеты»: могла,
    // просто показывала всем одно и то же.
    const own = cell.byCoin && cell.byCoin[row.coin];
    if (own && finite(own.pct) && own.pct >= 0 && own.pct <= 100 && finite(own.n) && own.n >= MIN_COIN_POINTS) {
      const pct = Math.round(Number(own.pct) * 10) / 10;
      // Своя ошибка доли, а не ошибка клетки: на тридцати наблюдениях она
      // около 8 пунктов, и делать вид, что число точное, нельзя.
      const se = Math.sqrt(pct / 100 * (1 - pct / 100) / Number(own.n)) * 100;
      return { hour: pct, se, ofCoin: true, group: groupPct,
        text: pct.toFixed(1) + '%', color: 'var(--blue)',
        why: 'Свежая частота касания цели +0.30% за час у самой ' + row.coin + ': ' + pct.toFixed(1) +
          '% ±' + se.toFixed(1) + ' п.п. на ' + own.n + ' наблюдениях, ' + period +
          '. По всей группе — ' + groupPct.toFixed(1) + '%, но внутри неё монеты расходятся на десятки ' +
          'пунктов, поэтому здесь число этой монеты. Частота касания — не прибыль: комиссии и спред не вычтены.' };
    }
    return { hour: groupPct, se: Number(cell.se), ofCoin: false, group: groupPct,
      text: groupPct.toFixed(1) + '%', color: 'var(--blue)',
      why: 'Своих наблюдений по ' + row.coin + ' не набралось, поэтому показана частота всей группы: ' +
        groupPct.toFixed(1) + '% ±' + Number(cell.se).toFixed(1) + ' п.п. (1 стандартная ошибка); ' + cell.coins + ' монет' +
        (finite(cell.n) ? ', ' + cell.n + ' наблюдений' : '') + ', ' + period +
        '. Внутри группы монеты расходятся на десятки пунктов, так что к этой монете число относится ' +
        'лишь приблизительно. Комиссии и спред не вычтены.' };
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
  // Самая высокая измеренная частота из показанных.
  //
  // Подсветка «выше базы» загорается почти на всех строках сразу: гейт по
  // падению сам отбирает клетки выше базы, и восемь одинаково зелёных строк
  // не выделяют ничего. Отдельно помечаем верхнюю клетку — это утверждение о
  // порядке, а не о прибыли: «из показанного здесь измеренная частота
  // наибольшая», и ничего больше.
  function recoveryPeak(rows, scan, now = scanNow(scan)) {
    let peak = null;
    for (const row of rows || []) {
      const hour = recoveryObservation(row, scan, now).hour;
      if (hour != null && (peak == null || hour > peak)) peak = hour;
    }
    return peak;
  }
  // Указатель, который показывает на пятерых, никуда не показывает.
  //
  // Частота у всей клетки одна, поэтому в падающем рынке весь список
  // сваливается в одну полосу падения и «максимум» достаётся половине
  // таблицы: 5 строк из 32 при 79%. Помечаем только тогда, когда пометка
  // действительно выделяет — одну или две строки. Иначе молчим и говорим
  // прямо, что верхние строки между собой неразличимы.
  // Цвет покупки принадлежит статусу входа, а не максимальной частоте.
  // Расчёт максимума нужен подписи о совпадающих процентах.
  const PEAK_MARK_MAX = 2;
  function recoveryPeakMark(rows, scan, now = scanNow(scan)) {
    // Считаем только по кандидатам. Частота принадлежит клетке, а не монете,
    // поэтому в ту же полосу падения попадают и строки «риск» с суточным
    // размахом от ±10%: у INJ и ZKC были те же 79%, что у ALGO, XRP и XLM.
    // Пометка «максимум» на строке, которая лежит внизу списка как опасная,
    // противоречит и списку, и себе.
    const gate = { fall: scan.gate && scan.gate.fallPct, spread: scan.gate && scan.gate.spreadPct };
    const eligible = (rows || []).filter(row =>
      recoveryVerdict(row, gate, recoveryObservation(row, scan, now), recoveryBuyCell(row, scan, now)).tier >= 2);
    const hour = recoveryPeak(eligible, scan, now);
    if (hour == null) return { hour: null, count: 0, show: false };
    const count = eligible.filter(row => recoveryObservation(row, scan, now).hour === hour).length;
    return { hour, count, show: count <= PEAK_MARK_MAX };
  }
  // Когда пометки нет, её отсутствие надо объяснить: иначе «максимум» просто
  // пропадает, и непонятно, сломалось что-то или так и задумано.
  function renderRecoveryTieNote(rows, scan, now = scanNow(scan)) {
    const peak = recoveryPeakMark(rows, scan, now);
    if (!peak.hour || peak.show) return '';
    // «Верхние 3 строк» читается как недосмотр и роняет доверие ко всему
    // остальному, что панель пишет числами.
    const tail = peak.count % 100 >= 11 && peak.count % 100 <= 14 ? 'строк'
      : peak.count % 10 === 1 ? 'строка' : peak.count % 10 >= 2 && peak.count % 10 <= 4 ? 'строки' : 'строк';
    return '<div style="font-size:10px;line-height:1.4;margin-bottom:6px;color:var(--t2);">' +
      '<b>' + peak.count + '</b> ' + tail + ' с максимальной частотой <b>' + peak.hour.toFixed(1) +
      '%</b>. При равном проценте и статусе выше более свежий сигнал.</div>';
  }
  // Сначала покупки, затем возможные покупки, затем остальные.
  // Внутри группы измеренные строки выше прочерков, по частоте цели.
  // Равные показанные проценты разбираем по свежести. Прочерк не получает
  // подставную оценку; сортировка не меняет разрешение на покупку.
  const MEASURED_FIRST = 1000;
  function recoveryOrder(row, scan, verdict, observation, now = scanNow(scan)) {
    const mark = verdict && recoveryRowMark(row, scan, verdict, observation, now);
    const priority = mark && mark.state === 'confirmed' ? 4000 : mark && mark.state === 'possible' ? 2000 : 0;
    const hour = observation && finite(observation.hour) && observation.hour >= 0 && observation.hour <= 100
      ? Math.round(Number(observation.hour) * 10) / 10 : null;
    const age = finite(row.inListMin) ? Math.max(0, Number(row.inListMin)) : 1e6;
    // Частота меняется шагами 0.1 п.п.; добавка за свежесть меньше этого шага.
    // Вся добавка внутри группы меньше расстояния между статусами.
    return priority + (hour == null ? 0 : MEASURED_FIRST + hour) + 0.01 / (1 + age / 60);
  }
  // Разрешена ли клетка этой монеты к покупке.
  //
  // Список приходит с сервера и пуст, пока ни одна клетка не показала плюс
  // после издержек дважды — на поиске и на проверке. Панель сама разрешений
  // не выдаёт и порогов не смягчает: её дело — показать то, что измерено.
  function validRecoveryBuyCell(cell) {
    return cell && [3, 6, 10].includes(cell.lo) && typeof cell.deep === 'boolean' &&
      [1, 4, 12, 24].includes(cell.horizonH) && [0.3, 1, 2, 3].includes(cell.target) &&
      // measure-net requires 12 coins × 15 entries in each of two periods.
      Number.isInteger(cell.n) && cell.n >= 360 &&
      ['netA', 'netB', 'seA', 'seB'].every(key => finite(cell[key])) && cell.seA >= 0 && cell.seB >= 0 &&
      cell.netA - 2 * cell.seA > 0 && cell.netB - 2 * cell.seB > 0;
  }
  function recoveryScanFresh(scan, now = scanNow(scan)) {
    return !scan.staleSince && finite(scan.at) && scan.at > 0 && scan.at <= now + 60000 && now - scan.at <= 5 * 60000;
  }
  function recoveryBuyCell(row, scan, now = scanNow(scan)) {
    if (!recoveryScanFresh(scan, now) || !finite(row.price) || row.price <= 0) return null;
    const cells = scan && scan.entryNet && scan.entryNet.buyCells;
    if (!Array.isArray(cells) || !cells.length) return null;
    const lo = fallBand(row);
    if (lo == null || !finite(row.pullbackPct)) return null;
    const deep = row.pullbackPct >= 1.5;
    return cells.find(c => validRecoveryBuyCell(c) && c.lo === lo && c.deep === deep) || null;
  }
  // Сначала вычисляем решение для всей вселенной, затем сокращаем ответ API.
  // Иначе разрешённая строка может остаться за пределами первых 15 монет.
  function recoverySignalRows(rows, scan) {
    const gate = { fall: scan.gate && scan.gate.fallPct, spread: scan.gate && scan.gate.spreadPct };
    return (rows || []).map(row => {
      const plan = recoveryBuyCell(row, scan);
      const verdict = recoveryVerdict(row, gate, { hour: null }, plan);
      return { ...row, buySignal: verdict.tier === 4, buyPlan: verdict.tier === 4 ? plan : null };
    }).sort((a, b) => Number(b.buySignal) - Number(a.buySignal));
  }
  function recoveryRowMark(row, scan, verdict, observation, now = scanNow(scan)) {
    const plain = { state: 'none', label: verdict.label, color: verdict.color, bg: verdict.bg, why: '' };
    if (!recoveryScanFresh(scan, now) || !finite(row.price) || row.price <= 0 || verdict.tier < 2) return plain;
    if (verdict.tier === 4) return { ...plain, state: 'confirmed',
      why: 'Зелёная рамка: вход подтверждён правилами и проверкой доходности группы. Это не гарантия прибыли.' };
    const edge = recoveryEdge(observation, recoveryBaseline(scan, now));
    if (!edge.above) return plain;
    // Было «возможная покупка». Строкой выше панель говорит, что покупать по
    // этому списку нельзя, и два этих текста на одном экране противоречат
    // друг другу — читают при этом короткий, а не длинный. Называем состояние
    // строки, а не действие: параметры подходят, прибыльность не измерена.
    return { state: 'possible', label: 'кандидат', color: 'var(--entry-possible)',
      bg: 'background:var(--entry-possible-bg);',
      why: 'Оранжевая рамка: параметры монеты подходят, свежая частота цели выше базы больше чем на две погрешности и минимум на 3 п.п. Прибыльность группы не подтверждена, и по прогону этот отбор издержек не окупает — это кандидат для наблюдения, а не для покупки.' };
  }
  function renderRecoveryGroups(sorted, scan, renderRow, columns) {
    const gate = { fall: scan.gate && scan.gate.fallPct, spread: scan.gate && scan.gate.spreadPct };
    const groups = { confirmed: [], possible: [], none: [] };
    for (const row of sorted) {
      const observation = recoveryObservation(row, scan);
      const verdict = recoveryVerdict(row, gate, observation, recoveryBuyCell(row, scan));
      groups[recoveryRowMark(row, scan, verdict, observation).state].push(row);
    }
    return [
      ['confirmed', 'Покупать', 'var(--entry-confirmed)'],
      ['possible', 'Кандидаты · покупка не разрешена', 'var(--entry-possible)'],
      ['none', 'Остальные', 'var(--t1)'],
    ].map(([state, label, color]) => {
      const rows = groups[state];
      const empty = state === 'confirmed' ? 'Сейчас нет подтверждённых сигналов покупки.'
        : state === 'possible' ? 'Сейчас нет кандидатов.' : '';
      return '<tr data-entry-group="' + state + '"><th colspan="' + columns +
        '" style="text-align:left;padding:10px 6px 5px;font-size:11px;color:' + color + ';">' +
        label + ' · ' + rows.length + '</th></tr>' +
        (rows.length ? rows.map(renderRow).join('') : empty ? '<tr><td colspan="' + columns +
          '" style="padding:4px 6px;font-size:10px;color:var(--t2);">' + empty + '</td></tr>' : '');
    }).join('');
  }
  function renderRecoveryRules(scan) {
    const gate = scan && scan.gate;
    const fall = gate && finite(gate.fallPct) ? Number(gate.fallPct) + '%' : 'неизвестен';
    const spread = gate && finite(gate.spreadPct) ? Number(gate.spreadPct) + '%' : 'неизвестен';
    const fresh = recoveryScanFresh(scan);
    return '<details class="recovery-help" data-recovery-detail="rules">' +
      '<summary>Условия покупки и обозначения' +
      (fresh ? '' : ' · скан не готов или устарел') + '</summary>' +
      '<div style="padding:5px 0;">' +
      '1. Падение от максимума за сутки — от <b>' + fall + '</b>; спред — не больше <b>' + spread + '</b>.<br>' +
      '2. Ход за сутки строго между −10% и +10%; цена и условия известны, скану не больше 5 минут.<br>' +
      '3. Для группы с таким падением и откатом подтверждён плюс после комиссий: средний результат минус две погрешности выше нуля в обеих частях проверки.<br>' +
      'Откат от максимума за 30 минут делит группы на &lt;1.5% и ≥1.5%; сам по себе глубокий откат не разрешает вход. RSI, рост BTC и процент «цель 1ч» не включают покупку.<br>' +
      '<b style="color:#00ffa8;">Подтверждённый вход: зелёная рамка и «брать» с целью и сроком, вверху списка.</b> ' +
      'Это прохождение правил алгоритма, не гарантия прибыли.<br>' +
      '<b style="color:var(--entry-possible);">Возможный вход: оранжевая рамка.</b> Параметры монеты подходят, свежая частота цели выше базы больше чем на две погрешности и минимум на 3 п.п., но проверка доходности ещё не пройдена. Покупка не разрешена.<br>' +
      'Без свежей оценки или при ходе за сутки от ±10% рамки входа нет. Серые строки — остальные монеты, красная отметка — повышенный риск. Нажатие на строку открывает график.<br>' +
      'Проверка доходности обновляется отдельным пересчётом; накопление часовой статистики само по себе покупку не разрешает.' +
      '</div></details>';
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
    const buy = Array.isArray(net.buyCells) ? net.buyCells.filter(validRecoveryBuyCell) : [];
    const details = [
      'Прогон по свечам: вход по цене, выход по цели лимитом либо по цене в конце горизонта маркетом, стоп -3%.',
      'В модели комиссии: мейкер 0.075%, тейкер 0.15%. Фактические комиссии зависят от тарифа счёта. Исторический спред и проскальзывание не измерены.',
      'Отбор: ' + pct(net.panel) + ' ±' + net.panelSe + ' за сделку на ' + net.n + ' входах.',
      'Случайный вход: ' + pct(net.control) + ' ±' + net.controlSe + ' на ' + net.controlN + '.',
      net.worst && finite(net.worst.diff)
        ? 'Хуже всего на длинном горизонте: ' + net.worst.horizonH + ' ч, цель ' + net.worst.target + '% — отбор ' +
          pct(net.worst.panel) + ' против ' + pct(net.worst.control) + ', разница ' + net.worst.diff + ' ±' + net.worst.se + ' п.п.'
        : '',
      'Это измерение периода, а не приговор правилу: исходная сетка мерилась на растущем рынке, здесь окно падающего.',
      'Пересчёт: node scripts/measure-net.js',
    ].filter(Boolean).join(String.fromCharCode(10));
    const box = (color, border, bg, html, summary) => '<details class="recovery-proof" data-recovery-detail="profit" title="' + escapeHtml(details) +
      '" style="font-size:10px;line-height:1.45;margin-bottom:6px;padding:5px 7px;border-radius:6px;' +
      'background:' + bg + ';border:1px solid ' + border + ';color:' + color + ';"><summary>' + summary +
      '<span class="recovery-detail-hint">Подробности</span></summary><div class="recovery-detail-body">' + html + '</div></details>';
    if (buy.length) {
      // Разрешение выдаётся клетке, а не монете: строки этих клеток помечены
      // словом «брать» вместе с горизонтом и целью выхода.
      return box('#9ff5cf', 'rgba(0,255,168,0.35)', 'rgba(0,255,168,0.10)',
        '<b>' + (buy.length === 1 ? 'Разрешена к покупке 1 клетка' : 'Разрешены к покупке ' + buy.length +
          (buy.length < 5 ? ' клетки' : ' клеток')) + '.</b> ' +
        'Плюс после комиссий модели и на поиске, и на проверке (' + escapeHtml(String(net.from)) + ' — ' +
        escapeHtml(String(net.to)) + '). В таблице такие строки помечены словом «брать» с горизонтом и целью. ' +
        'Остальные строки — наблюдение. ' + (recoveryScanFresh(scan) ? '' : 'Скан не готов или устарел: сигналы покупки отключены.'),
        recoveryScanFresh(scan) ? 'Проверку прошли группы: ' + buy.length : 'Скан устарел — сигналы покупки отключены');
    }
    return box('#ff9f9f', 'rgba(255,107,107,0.35)', 'rgba(255,107,107,0.10)',
      '<b>Покупать по этому списку нельзя.</b> Прогон по свечам ' + escapeHtml(String(net.from)) + ' — ' +
      escapeHtml(String(net.to)) + ': отбор давал <b>' + pct(net.panel) + '</b> за сделку против <b>' +
      pct(net.control) + '</b> у случайного входа. Из ' + net.modes + ' режимов (горизонты 1/4/12/24 ч) ' +
      (okModes ? 'окупились ' + okModes : 'не окупился <b>ни один</b>') +
      '. Ни одна клетка не прошла порог покупки. Это список наблюдения, а не список покупки.',
      'Покупки не подтверждены. Оранжевые — наблюдение.');
  }
  // Цвета объясняются один раз — в блоке правил, где рядом нарисованы сами
  // рамки. Здесь они дублировались словами, и над таблицей из двенадцати
  // строк стояло двенадцать строк объяснений.
  function renderRecoveryLegend(scan, now = scanNow(scan)) {
    const base = recoveryBaseline(scan, now);
    if (!base) return '';
    return '<div class="recovery-legend" title="Частота касания цели +0.30% за час до комиссий. ▲ означает превышение базы больше двух погрешностей и минимум на 3 п.п. Это не оценка прибыли.">' +
      '<b>▲</b> — частота выше базы ' + base.pct.toFixed(1) + '%, не разрешение покупать. ' +
      'Внутри групп — цель 1ч по убыванию; при равенстве — свежие выше.</div>';
  }
  function recoveryVerdict(row, gate, observation, buyCell) {
    const out = (tier, label, why, risk = false) => ({ tier, label, why,
      color: risk ? '#ff6b6b' : 'var(--t2)', bg: risk ? 'background:rgba(255,107,107,0.08);' : '' });
    if (!finite(row.chg24Pct) || !finite(row.pullbackPct)) return out(0, 'данные', 'Неизвестен ход за сутки или откат.');
    if (!finite(gate.fall) || !finite(gate.spread) || !finite(row.dayFallPct) || row.dayFallPct < gate.fall || !finite(row.spreadPct) ||
        row.spreadPct < 0 || row.spreadPct > gate.spread) return out(0, '—', 'Порог падения или спреда не пройден.');
    if (Math.abs(row.chg24Pct) >= 10) return out(1, 'риск', 'Ход за сутки от ±10%: повышенная амплитуда движения.', true);
    const tier = row.pullbackPct >= 1.5 ? 3 : 2;
    // «Брать» появляется только там, где измеренный результат после издержек
    // положителен дважды: на поиске и на проверке. Вместе со словом идёт план
    // выхода — без него «брать» не значит ничего: цель +0.30% равна круговому
    // обороту тейкером, и сделка без цели и срока съедается комиссией.
    if (validRecoveryBuyCell(buyCell)) {
      const plan = buyCell.horizonH + 'ч +' + buyCell.target + '%';
      return { tier: 4, label: 'брать ' + plan, color: '#00ffa8',
        bg: 'background:rgba(0,255,168,0.12);',
        why: 'Клетка разрешена к покупке: после комиссий модели ' + Number(buyCell.netA).toFixed(2) +
          '% на поиске и ' + Number(buyCell.netB).toFixed(2) + '% на проверке, наблюдений ' +
          (buyCell.n || '?') + '. Выход: цель +' + buyCell.target + '% лимитом, срок ' +
          buyCell.horizonH + ' ч, дальше по цене; стоп −3%. Спред и проскальзывание в историческом прогоне не измерены. Это средний результат группы, а не обещание по этой монете.' };
    }
    return observation.hour == null
      ? out(tier, 'нет оценки', observation.why)
      : out(tier, 'наблюдать', 'Условия отката выполнены. Прибыльность отбора не подтверждена; частота цели не разрешает покупку.');
  }
  // СВЕЖЕЕ ПЕРЕСЕЧЕНИЕ ИЛИ ЗАТЯНУВШЕЕСЯ ДВИЖЕНИЕ.
  //
  // Журнал записывает сигналом только первые ENTRY_FRESH_MIN минут: дальше
  // это не новое событие, а одно движение, которое всё ещё идёт. Порог тот
  // же, по которому сервер отбирает сделки в форвардный журнал.
  //
  // На экране этого не было видно вовсе. В списке стояли строки с «21 ч» и
  // «39 ч» — то есть ни одна из них не была сигналом, хотя выглядели они как
  // кандидаты наравне с только что появившимися.
  //
  // Это отметка о новизне события, а не о доходности: что свежие входы лучше
  // затянувшихся, никто не измерял, и порядок строк от неё не зависит.
  const ENTRY_FRESH_MIN = 4;
  function recoveryFresh(row) {
    return finite(row.inListMin) && Number(row.inListMin) <= ENTRY_FRESH_MIN;
  }
  function recoveryHeldNote(row) {
    if (!finite(row.inListMin)) return 'Сколько монета уже удовлетворяет условиям — неизвестно.';
    return recoveryFresh(row)
      ? 'Свежее пересечение: условия выполнились меньше ' + ENTRY_FRESH_MIN +
        ' минут назад. Только такие строки форвардный журнал записывает сигналом.'
      : 'Условия держатся уже ' + row.inListMin + ' мин. Это не новый сигнал, а одно затянувшееся ' +
        'движение: журнал такие не записывает. На саму частоту цели это не влияет — она у клетки одна.';
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
    // Пропущенные монеты не гасят отчёт, но замолчать их нельзя: измерение
    // прошло не по всей корзине, и знать об этом надо.
    const missed = report && Array.isArray(report.missingCoins) && report.missingCoins.length
      ? ' Неполная история: ' + report.missingCoins.length + ' (' +
        report.missingCoins.slice(0, 3).map(escapeHtml).join(', ') +
        (report.missingCoins.length > 3 ? ' и др.' : '') + ') — они в исторический замер не вошли. Это отдельно от текущего скана.'
      : '';
    if (report && report.status === 'drift') {
      message = 'Историческая сетка разошлась с проверкой. Показаны свежие наблюдения; где данных мало — прочерк.' + window + missed;
    } else if (report && report.status === 'incomplete') {
      message = 'Свежие наблюдения: для части групп данных мало — показан прочерк.' + window + missed;
    } else if (report && report.status === 'no-drift') {
      message = 'Показана свежая частота цели за час; прибыльность отбора не подтверждена.' + missed;
      color = 'var(--t2)';
    } else if (check && check.current && check.code !== 0) {
      message = 'Свежая проверка не завершилась — оценка недоступна.';
    }
    const thin = report ? report.cells.filter(cell => !validCell(cell)).length : 0;
    const summary = report ? 'Статистика: ' + (days == null ? '' : days + ' сут') +
      (thin ? ' · групп без оценки: ' + thin : ' · оценки доступны') +
      (report.missingCoins.length ? ' · история неполная' : '') : 'Свежая оценка недоступна';
    return '<details class="recovery-quality" data-recovery-detail="quality" style="color:' + (report ? 'var(--t2)' : color) + ';">' +
      '<summary>' + summary + '</summary><div class="recovery-detail-body">' + message + '</div></details>';
  }
  function renderRecoveryMissing(scan) {
    if (!Array.isArray(scan.missed) || !scan.missed.length) return '';
    const names = scan.missed.map(escapeHtml).join(', ');
    return '<details class="recovery-missing" data-recovery-detail="missing"><summary>Текущий скан: нет данных по ' + names + '</summary>' +
      '<div class="recovery-detail-body">' + scan.missed.map(coin => '<div><b>' + escapeHtml(coin) + '</b>: ' +
        escapeHtml(scan.missedDetails && scan.missedDetails[coin] || 'Биржа не вернула достаточно данных.') + '</div>').join('') +
      'Это не значит, что условия перестали выполняться. Повторная проверка — в следующем скане.</div></details>';
  }
  function recoveryDetailsState(box) {
    return box.querySelectorAll ? Array.from(box.querySelectorAll('details[data-recovery-detail][open]'), el => el.dataset.recoveryDetail) : [];
  }
  function restoreRecoveryDetails(box, open) {
    if (box.querySelectorAll) for (const el of box.querySelectorAll('details[data-recovery-detail]')) el.open = open.includes(el.dataset.recoveryDetail);
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
  const api = { renderEntryJournal, renderRecoveryStatus, renderRecoveryLegend, renderRecoveryNet, recoveryObservation,
    recoveryVerdict, recoveryDayChange, recoveryBaseline, recoveryEdge, recoveryOrder, recoveryPeak, recoveryPeakMark, renderRecoveryTieNote, recoveryBuyCell,
    recoveryFresh, recoveryHeldNote,
    recoverySignalRows, renderRecoveryRules, recoveryRowMark, renderRecoveryGroups,
    renderRecoveryMissing, recoveryDetailsState, restoreRecoveryDetails,
    escapeRecoveryText: escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
