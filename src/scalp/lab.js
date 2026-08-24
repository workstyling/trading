/**
 * ЛАБОРАТОРИЯ СТРАТЕГИИ СКАЛЬПА.
 * ────────────────────────────────────────────────────────────────────────
 * Работает в фоне, пока включена. На каждый вход по гейту открывает
 * виртуальную сделку и запоминает ПОЛНЫЙ контекст входа. Когда сделка
 * закрывается — сопоставляет контекст с исходом.
 *
 * Раз в несколько часов разбирает накопленное и формулирует наблюдения:
 * в каких условиях гейт работает, а в каких сливает. Наблюдения пишутся
 * готовым текстом, который можно скопировать и отдать Claude Code как
 * задание на правку алгоритма.
 *
 * Смысл: пороги гейта откалиброваны на одной неделе истории. Живые сделки
 * — независимая проверка, и она копится сама.
 */

/** Разрезы, по которым ищем расхождения. Каждый — функция от контекста входа. */
const BUCKETS = {
  'Позиция в 4ч диапазоне': (c) => {
    if (c.rangePos == null) return null;
    return c.rangePos < 0.10 ? 'у самого дна (<10%)'
      : c.rangePos < 0.18 ? 'низко (10–18%)'
      : 'верх зоны (18–25%)';
  },
  'RSI 5m на входе': (c) => {
    if (c.rsi == null) return null;
    return c.rsi < 40 ? 'RSI < 40' : c.rsi < 50 ? 'RSI 40–50' : c.rsi < 60 ? 'RSI 50–60' : 'RSI 60+';
  },
  'Насколько RSI отскочил от ямы': (c) => {
    if (c.rsi == null || c.rsiMin == null) return null;
    const d = c.rsi - c.rsiMin;
    return d < 6 ? 'едва вышел (<6)' : d < 12 ? 'умеренно (6–12)' : 'сильно (12+)';
  },
  'Спред на входе': (c) => {
    if (c.spreadPct == null) return null;
    return c.spreadPct < 0.05 ? 'узкий (<0.05%)'
      : c.spreadPct < 0.15 ? 'нормальный (0.05–0.15%)'
      : c.spreadPct < 0.3 ? 'широковат (0.15–0.3%)'
      : 'широкий (0.3%+)';
  },
  'Объём монеты': (c) => {
    if (!c.vol24) return null;
    return c.vol24 < 1e6 ? '$0.5–1M' : c.vol24 < 5e6 ? '$1–5M' : c.vol24 < 20e6 ? '$5–20M' : '$20M+';
  },
  'Всплеск объёма на входе': (c) => {
    if (c.volX == null) return null;
    return c.volX < 1 ? 'ниже среднего' : c.volX < 1.5 ? 'обычный' : c.volX < 3 ? 'повышенный (1.5–3x)' : 'всплеск (3x+)';
  },
  'Запас BTC над EMA20': (c) => {
    if (c.btcDist == null) return null;
    return c.btcDist < 0.2 ? 'впритык (<0.2%)' : c.btcDist < 1 ? 'умеренный (0.2–1%)' : 'уверенный (1%+)';
  },
  'Час входа (UTC)': (c) => {
    if (c.hourUtc == null) return null;
    const h = c.hourUtc;
    return h < 6 ? '00–06' : h < 12 ? '06–12' : h < 18 ? '12–18' : '18–24';
  },
  'Балл гейта': (c) => {
    if (c.score == null) return null;
    return c.score < 90 ? '86–90' : c.score < 95 ? '90–95' : '95–100';
  },
};

/** Сводка по набору сделок */
function agg(trades) {
  if (!trades.length) return null;
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const totalPct = trades.reduce((a, t) => a + t.pnlPct, 0);
  const holds = trades.map(t => t.holdH).filter(x => x != null);
  return {
    n: trades.length,
    wins, losses: trades.length - wins,
    winRate: Math.round(wins / trades.length * 100),
    avgPct: Math.round(totalPct / trades.length * 1000) / 1000,
    totalUsd: Math.round(trades.reduce((a, t) => a + (t.pnl || 0), 0) * 100) / 100,
    avgHoldH: holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length * 10) / 10 : null,
    worstPct: Math.round(Math.min(...trades.map(t => t.pnlPct)) * 100) / 100,
  };
}

/**
 * Ищем разрезы, где результат заметно расходится с общим.
 * Порог: минимум 8 сделок в группе и отклонение ≥0.25 п.п. по среднему.
 */
function findObservations(trades, opts = {}) {
  const minN = opts.minN || 8;
  const minDelta = opts.minDelta || 0.25;
  const base = agg(trades);
  if (!base || base.n < 15) return { base, observations: [], enough: false };

  const observations = [];
  for (const [dim, fn] of Object.entries(BUCKETS)) {
    const groups = {};
    for (const t of trades) {
      const k = fn(t.ctx || {});
      if (k == null) continue;
      (groups[k] || (groups[k] = [])).push(t);
    }
    const rows = Object.entries(groups)
      .map(([k, arr]) => ({ key: k, ...agg(arr) }))
      .filter(r => r.n >= minN);
    if (rows.length < 2) continue;

    for (const r of rows) {
      const delta = Math.round((r.avgPct - base.avgPct) * 1000) / 1000;
      if (Math.abs(delta) < minDelta) continue;
      observations.push({
        dim, group: r.key, n: r.n, winRate: r.winRate,
        avgPct: r.avgPct, delta,
        worstPct: r.worstPct, avgHoldH: r.avgHoldH,
        direction: delta > 0 ? 'лучше' : 'хуже',
      });
    }
  }
  observations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { base, observations, enough: true };
}

/**
 * Готовый текст задания для Claude Code. Пользователь копирует его целиком
 * и отдаёт как есть — там уже есть и цифры, и куда именно править.
 */
function buildBrief(trades, meta) {
  const { base, observations, enough } = findObservations(trades);
  const lines = [];
  const d = (v) => (v >= 0 ? '+' : '') + v;

  lines.push('# Задание: улучшить гейт скальпа по живым данным');
  lines.push('');
  lines.push('Ниже — результаты реальных paper-сделок, открытых автоматически на каждом');
  lines.push('срабатывании гейта скальпа. Это независимая проверка порогов, которые были');
  lines.push('откалиброваны на одной неделе исторических данных.');
  lines.push('');
  lines.push('## Где живёт код');
  lines.push('');
  lines.push('- `src/scalp/index.js` — `calcScalpScore()`: гейт из 4 условий и баллы');
  lines.push('- `src/scalp/scanner.js` — `applyRegime()`: жёсткое условие по BTC');
  lines.push('- `src/scalp/backtest.js`, `exits.js`, `research.js` — как перепроверять на истории');
  lines.push('');
  lines.push('Текущий гейт: позиция в 4ч диапазоне < 25%, RSI 5m вышел из перепроданности');
  lines.push('(минимум за час < 30 и текущий выше минимума на 3+), цена выше EMA9 (5m),');
  lines.push('объём ≥ $500K, BTC выше EMA20 (1ч). Цель +1.38%, аварийный стоп −6%.');
  lines.push('');
  lines.push('## Что дали живые сделки');
  lines.push('');
  if (!base) {
    lines.push('Сделок пока нет.');
    return lines.join('\n');
  }
  lines.push(`- Собрано сделок: **${base.n}**` + (meta && meta.since ? ` за ${meta.since}` : ''));
  lines.push(`- Побед: **${base.winRate}%** (${base.wins} из ${base.n})`);
  lines.push(`- Средний результат: **${d(base.avgPct)}%** на сделку (комиссии учтены)`);
  lines.push(`- Итого: **${d(base.totalUsd)}$**` + (base.avgHoldH != null ? `, среднее удержание ${base.avgHoldH} ч` : ''));
  lines.push(`- Худшая сделка: **${base.worstPct}%**`);
  lines.push('');
  lines.push('Ожидание по историческому бэктесту было +0.914% на сделку при 68% побед.');
  const drift = Math.round((base.avgPct - 0.914) * 1000) / 1000;
  lines.push(`Расхождение с живыми данными: **${d(drift)} п.п.**`);
  lines.push('');

  if (!enough) {
    lines.push('## Выводы');
    lines.push('');
    lines.push(`Сделок пока мало (${base.n}), для разрезов нужно хотя бы 15. Дай накопиться.`);
    return lines.join('\n');
  }

  if (!observations.length) {
    lines.push('## Выводы');
    lines.push('');
    lines.push('Ни один разрез не даёт отклонения ≥0.25 п.п. от общего среднего.');
    lines.push('Это значит, что гейт работает одинаково во всех замеренных условиях —');
    lines.push('сужать его пока не на чем. Продолжай копить сделки.');
    return lines.join('\n');
  }

  lines.push('## Найденные расхождения');
  lines.push('');
  lines.push('| Разрез | Группа | Сделок | Побед | Средний | Отклонение |');
  lines.push('|---|---|---|---|---|---|');
  for (const o of observations.slice(0, 12)) {
    lines.push(`| ${o.dim} | ${o.group} | ${o.n} | ${o.winRate}% | ${d(o.avgPct)}% | **${d(o.delta)} п.п.** |`);
  }
  lines.push('');
  lines.push('## Что предлагается сделать');
  lines.push('');
  let i = 1;
  for (const o of observations.slice(0, 6)) {
    if (o.delta < 0) {
      lines.push(`${i++}. **${o.dim} — «${o.group}» работает хуже** (${o.n} сделок, ${o.winRate}% побед, ${d(o.avgPct)}%, это ${d(o.delta)} п.п. к среднему).`);
      lines.push(`   Проверить на истории, стоит ли исключить такие входы или снизить им балл.`);
    } else {
      lines.push(`${i++}. **${o.dim} — «${o.group}» работает лучше** (${o.n} сделок, ${o.winRate}% побед, ${d(o.avgPct)}%, это ${d(o.delta)} п.п. к среднему).`);
      lines.push(`   Проверить, не стоит ли поднять таким входам балл или сделать условие обязательным.`);
    }
    lines.push('');
  }
  lines.push('## Обязательное требование');
  lines.push('');
  lines.push('Каждое изменение сначала прогнать на исторических данных');
  lines.push('(`node src/scalp/backtest.js 7 500000`) и проверить устойчивость по трём');
  lines.push('отрезкам времени. Правки, которые улучшают только общий результат, но');
  lines.push('не держатся на отрезках, не принимать — так уже было с сигналом');
  lines.push('«возраст входа» и с выходом по EMA9.');
  lines.push('');
  lines.push('Выборка мала и покрывает один режим рынка. Это подсказка, куда смотреть,');
  lines.push('а не готовое решение.');
  return lines.join('\n');
}

module.exports = { BUCKETS, agg, findObservations, buildBrief };
