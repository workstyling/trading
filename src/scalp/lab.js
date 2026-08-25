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

/**
 * Разрезы, по которым ищем расхождения. Каждый — функция от контекста входа.
 * Подписи по-английски: этот текст уезжает в задание для Claude Code, а
 * кириллица на пути через shell превращалась в мусор.
 */
const BUCKETS = {
  'Position in 4h range': (c) => {
    if (c.rangePos == null) return null;
    return c.rangePos < 0.10 ? 'very bottom (<10%)'
      : c.rangePos < 0.18 ? 'low (10-18%)'
      : 'upper part of zone (18-25%)';
  },
  'RSI 5m at entry': (c) => {
    if (c.rsi == null) return null;
    return c.rsi < 40 ? 'RSI < 40' : c.rsi < 50 ? 'RSI 40-50' : c.rsi < 60 ? 'RSI 50-60' : 'RSI 60+';
  },
  'How far RSI bounced off its low': (c) => {
    // Number.isFinite, а не != null: NaN раньше проходил проверку и все такие
    // сделки сваливались в группу «сильно (12+)», беззвучно искажая разрез
    if (!Number.isFinite(c.rsi) || !Number.isFinite(c.rsiMin)) return null;
    const d = c.rsi - c.rsiMin;
    return d < 6 ? 'barely (<6)' : d < 12 ? 'moderate (6-12)' : 'strong (12+)';
  },
  'Spread at entry': (c) => {
    if (c.spreadPct == null) return null;
    return c.spreadPct < 0.05 ? 'tight (<0.05%)'
      : c.spreadPct < 0.15 ? 'normal (0.05-0.15%)'
      : c.spreadPct < 0.3 ? 'wide-ish (0.15-0.3%)'
      : 'wide (0.3%+)';
  },
  'Coin volume': (c) => {
    if (!c.vol24) return null;
    return c.vol24 < 1e6 ? '$0.5-1M' : c.vol24 < 5e6 ? '$1-5M' : c.vol24 < 20e6 ? '$5-20M' : '$20M+';
  },
  'Volume surge at entry': (c) => {
    if (c.volX == null) return null;
    return c.volX < 1 ? 'below average' : c.volX < 1.5 ? 'normal' : c.volX < 3 ? 'elevated (1.5-3x)' : 'surge (3x+)';
  },
  'BTC headroom above EMA20': (c) => {
    if (c.btcDist == null) return null;
    return c.btcDist < 0.2 ? 'razor thin (<0.2%)' : c.btcDist < 1 ? 'moderate (0.2-1%)' : 'comfortable (1%+)';
  },
  'Entry hour (UTC)': (c) => {
    if (c.hourUtc == null) return null;
    const h = c.hourUtc;
    return h < 6 ? '00-06' : h < 12 ? '06-12' : h < 18 ? '12-18' : '18-24';
  },
  'Gate score': (c) => {
    if (c.score == null) return null;
    return c.score < 90 ? '86-90' : c.score < 95 ? '90-95' : '95-100';
  },
  // Ниже — то, что гейт проверяет порогом, но внутри порога не различает.
  // Порог 8% и 15% выбраны бэктестом; живые сделки могут показать, что
  // внутри разрешённой зоны результат тоже неоднороден.
  '4h range width': (c) => {
    if (c.range4Pct == null) return null;
    return c.range4Pct < 2 ? 'very tight (<2%)'
      : c.range4Pct < 4 ? 'tight (2-4%)'
      : c.range4Pct < 6 ? 'medium (4-6%)'
      : 'near the 8% limit (6-8%)';
  },
  '24h run-up before entry': (c) => {
    if (c.runUp24 == null) return null;
    return c.runUp24 < -3 ? 'was falling (<-3%)'
      : c.runUp24 < 3 ? 'flat (-3 to +3%)'
      : c.runUp24 < 8 ? 'rising (3-8%)'
      : 'near the pump limit (8-15%)';
  },
  'Drop from 4h high': (c) => {
    if (c.dropFromHigh == null) return null;
    return c.dropFromHigh < 2 ? 'shallow (<2%)'
      : c.dropFromHigh < 4 ? 'moderate (2-4%)'
      : 'deep (4%+)';
  },
};

/**
 * Что дала бы ДРУГАЯ цель и другой стоп — на уже собранных сделках.
 *
 * Пик (mfe) и дно (mae) каждой сделки записаны по ходу её жизни, поэтому
 * исход при любом пороге восстанавливается точно: если дно опустилось ниже
 * стопа — стоп; иначе если пик дошёл до цели — цель. Единственное, чего
 * пик и дно не хранят, — порядок событий, поэтому при совпадении считаем
 * срабатывание стопа (консервативно: так результат не завышается).
 */
function sweepTargets(exits, fee, targets, stops) {
  const rows = [];
  const valid = exits.filter(e => Number.isFinite(e.mfe) && Number.isFinite(e.mae));
  if (valid.length < 5) return { rows, n: valid.length };
  for (const tp of targets) {
    for (const sl of stops) {
      let sum = 0, wins = 0, hitTp = 0, hitSl = 0;
      for (const e of valid) {
        let pnl;
        if (sl > 0 && e.mae <= -sl) { pnl = -sl - fee; hitSl++; }
        else if (e.mfe >= tp) { pnl = tp - fee; hitTp++; }
        else pnl = e.pnlPct != null ? e.pnlPct : 0;   // ни туда ни сюда — как закрылась
        sum += pnl;
        if (pnl > 0) wins++;
      }
      rows.push({
        tp, sl, n: valid.length,
        exp: Math.round(sum / valid.length * 1000) / 1000,
        winRate: Math.round(wins / valid.length * 100),
        tpShare: Math.round(hitTp / valid.length * 100),
        slShare: Math.round(hitSl / valid.length * 100),
      });
    }
  }
  return { rows, n: valid.length };
}

/**
 * Гроздья входов.
 *
 * Гейт срабатывает пачками: когда BTC выше EMA20 и рынок разом проседает,
 * условия выполняются у десятка монет за считанные минуты, а потом часами
 * не срабатывает ничего. Замерено на живых данных — двенадцать входов за
 * 1.2 часа, медианный интервал между ними 0.1 часа, затем ноль за три часа.
 *
 * Двенадцать позиций, открытых на одном движении рынка, — это одна ставка,
 * а не двенадцать: они выиграют и проиграют вместе. Считать их независимыми
 * значит переоценивать надёжность выборки в разы, и именно так первое
 * поколение показало «win 100%» — оно поймало одну удачную гроздь.
 */
function clusters(trades, gapMin = 30) {
  const ts = (trades || []).filter(t => t.openedAt).sort((a, b) => a.openedAt - b.openedAt);
  if (!ts.length) return [];
  const out = [[ts[0]]];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i].openedAt - ts[i - 1].openedAt > gapMin * 60000) out.push([]);
    out[out.length - 1].push(ts[i]);
  }
  return out;
}

/** Среднее по гроздьям, а не по сделкам: честная оценка при кучных входах */
function clusterStats(trades) {
  const cl = clusters(trades);
  if (!cl.length) return null;
  const perCluster = cl.map(c => c.reduce((a, t) => a + t.pnlPct, 0) / c.length);
  const mean = perCluster.reduce((a, b) => a + b, 0) / perCluster.length;
  const wins = perCluster.filter(v => v > 0).length;
  const sizes = cl.map(c => c.length).sort((a, b) => a - b);
  return {
    nClusters: cl.length,
    avgPerCluster: Math.round(mean * 1000) / 1000,
    clusterWinRate: Math.round(wins / cl.length * 100),
    biggest: sizes[sizes.length - 1],
    medianSize: sizes[Math.floor(sizes.length / 2)],
  };
}

/** Сводка по группе «не хватило двух условий» — насколько зажат гейт */
function aggFar(trades) {
  const a = agg(trades || []);
  if (!a) return null;
  const byPair = {};
  for (const t of trades) {
    const k = t.missing || '—';
    (byPair[k] || (byPair[k] = [])).push(t);
  }
  return {
    ...a,
    pairs: Object.entries(byPair)
      .map(([cond, arr]) => ({ cond, ...agg(arr) }))
      .filter(x => x.n >= 3)
      .sort((x, y) => y.n - x.n)
      .slice(0, 8),
  };
}

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
  if (!base || base.n < 15) return { base, observations: [], enough: false, cl: clusterStats(trades) };
  // Пятнадцать сделок из двух гроздей — это два наблюдения, а не пятнадцать.
  // Разрезы по такой выборке находят свойства одного движения рынка и выдают
  // их за свойства гейта.
  const cl = clusterStats(trades);
  const minClusters = opts.minClusters || 4;
  if (cl && cl.nClusters < minClusters) return { base, observations: [], enough: false, cl, tooClustered: true };

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
        direction: delta > 0 ? 'better' : 'worse',
      });
    }
  }
  observations.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { base, observations, enough: true, cl };
}

/**
 * Готовый текст задания для Claude Code. Пользователь копирует его целиком
 * и отдаёт как есть — там уже есть и цифры, и куда именно править.
 */
function buildBrief(trades, meta) {
  const { base, observations, enough } = findObservations(trades);
  const lines = [];
  const d = (v) => (v >= 0 ? '+' : '') + v;

  lines.push('# Task: improve the scalp gate using live data');
  lines.push('');
  lines.push('Below are results from paper trades opened automatically on every scalp gate');
  lines.push('trigger. This is an independent check on thresholds that were calibrated on a');
  lines.push('single week of historical data.');
  lines.push('');
  lines.push('## Where the code lives');
  lines.push('');
  lines.push('- `src/scalp/index.js` — `calcScalpScore()`: gate conditions and scoring');
  lines.push('- `src/scalp/scanner.js` — `applyRegime()`: the hard BTC regime condition');
  lines.push('- `src/scalp/backtest.js`, `exits.js`, `research.js` — how to re-check on history');
  lines.push('');
  // Условия читаются из живого расчёта, а не вписаны сюда руками: иначе
  // после правки алгоритма задание описывало бы прошлую версию.
  const live = (meta && meta.liveChecks) || [];
  if (live.length) {
    lines.push(`Current gate — ${live.length} conditions (read from the running scanner):`);
    lines.push('');
    live.forEach(k => lines.push(`- ${k}`));
    lines.push('');
    if (meta.fingerprint) lines.push(`Gate code fingerprint: \`${meta.fingerprint}\``);
    if (meta.targetPct) lines.push(`Target +${meta.targetPct}%, catastrophe stop -${meta.slPct}%.`);
    lines.push('');
  }

  // История поколений: что уже внедрено — чтобы не предлагать то же самое.
  // Авто-поколения без единой сделки отбрасываем: раздел называется «что уже
  // внедрено», а такая запись говорит только «код менялся» и ничего не
  // измеряет. Правка гейта из двух коммитов подряд плодила их пачками.
  const gens = ((meta && meta.generations) || []).filter(g => !(g.auto && !g.trades));
  if (gens.length) {
    lines.push('## Already applied (do not propose again)');
    lines.push('');
    gens.slice(-6).forEach((g, k) => {
      const dt = new Date(g.at).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(`**${dt} UTC** — generation ${gens.length - Math.min(6, gens.length) + k + 1}, ${g.trades} trades collected` +
        (g.stats ? `, win ${g.stats.winRate}%, ${g.stats.avgPct >= 0 ? '+' : ''}${g.stats.avgPct}% per trade` : ''));
      if (g.note) {
        g.note.split('\n').filter(Boolean).forEach(l => lines.push(`  - ${l}`));
      } else if (g.observations && g.observations.length) {
        g.observations.slice(0, 3).forEach(o =>
          lines.push(`  - found at the time: ${o.dim} "${o.group}" ${o.delta >= 0 ? '+' : ''}${o.delta} pp`));
      }
      lines.push('');
    });
    // Раньше здесь стояло безусловное «всё собрано после правки». Сделки,
    // открытые до смены поколения, продолжают вестись и закрываются уже в
    // новом — то есть утверждение было неверным ровно тогда, когда это важно.
    const stale = (meta && meta.staleCount) || 0;
    if (stale) {
      lines.push(`Of the trades below, ${stale} were OPENED before the last generation change`);
      lines.push('and closed after it. They are counted, but they did not test the change.');
    } else {
      lines.push('The numbers below were collected AFTER the last change — they test what it');
      lines.push('did, they are not a repeat of the earlier analysis.');
    }
    lines.push('');
  }
  lines.push('## What the live trades produced');
  lines.push('');
  if (!base) {
    // Раньше здесь стояло голое «No trades yet», пока в работе висело три
    // десятка позиций. Задание выглядело сломанным, хотя лаборатория шла
    // полным ходом: закрытых просто ещё не было. Показываем, что в полёте.
    const op = (meta && meta.openNow) || null;
    if (!op || !op.n) {
      lines.push('No trades yet, and none are open. Check that the lab is switched on.');
    } else {
      lines.push('Nothing has CLOSED yet, so there is nothing to conclude from. That is not');
      lines.push(`a stall — **${op.n} trades are running right now** and will close as they hit`);
      lines.push('the target, the stop, or the 48h limit.');
      lines.push('');
      lines.push(`- Gate entries in flight: **${op.gate}**, control group: **${op.shadow}**` +
        (op.far ? `, wider control: **${op.far}**` : ''));
      lines.push(`- Oldest open **${op.oldestH}h**, youngest **${op.youngestH}h**`);
      lines.push(`- Currently in profit: **${op.up}** of ${op.n}`);
      if (op.bestMfe != null) {
        lines.push(`- Best peak reached so far **${d(op.bestMfe)}%**, deepest trough **${d(op.worstMae)}%**`);
      }
      if (op.clusters) {
        lines.push(`- They arrived in **${op.clusters} bursts**, biggest ${op.biggest} entries at once`);
      }
      lines.push('');
      if (op.oldestH >= 24) {
        lines.push('The oldest are past a day. At a +2% target, most trades that are going to');
        lines.push('work have worked by then, so expect these to close on the 48h limit rather');
        lines.push('than the target — which is itself a finding about the target.');
        lines.push('');
      }
      lines.push('Come back once trades start closing. Nothing here can be acted on yet.');
    }
    return lines.join('\n');
  }
  lines.push(`- Trades collected: **${base.n}**` + (meta && meta.since ? ` over ${meta.since}` : ''));
  lines.push(`- Wins: **${base.winRate}%** (${base.wins} of ${base.n})`);
  lines.push(`- Average result: **${d(base.avgPct)}%** per trade (fees included)`);
  lines.push(`- Total: **${d(base.totalUsd)}$**` + (base.avgHoldH != null ? `, average hold ${base.avgHoldH}h` : ''));
  lines.push(`- Worst trade: **${base.worstPct}%**`);
  lines.push('');
  // База именно скальп-гейта: +0.199% при 68% побед (28 252 сэмпла, 6ч горизонт).
  // Раньше здесь стояло +0.914% — это число из теста стопов для paper-бота,
  // и задание всегда докладывало, что гейт сломан.
  const BASE_EXP = 0.199, BASE_WIN = 68;
  // Кучность: без неё выборка выглядит втрое-вчетверо надёжнее, чем она есть
  const cl = clusterStats(trades);
  if (cl) {
    lines.push(`- Independent bursts: **${cl.nClusters}** (entries within 30 min of each other count as one)`);
    lines.push(`- Per-burst average: **${d(cl.avgPerCluster)}%**, ${cl.clusterWinRate}% of bursts positive`);
    lines.push('');
    if (cl.nClusters < 6) {
      lines.push(`These ${base.n} trades are really **${cl.nClusters} events**. The gate fires in clumps:`);
      lines.push('when BTC is above EMA20 and the market dips together, a dozen coins qualify');
      lines.push('within minutes, then nothing for hours. Trades inside one burst win and lose');
      lines.push('together, so treat the per-burst figure as the honest one and the per-trade');
      lines.push('figure as optimistic.');
      lines.push('');
    }
  }
  lines.push(`Historical backtest expectancy for the scalp gate: **+${BASE_EXP}%** per trade at ${BASE_WIN}% wins.`);
  const drift = Math.round((base.avgPct - BASE_EXP) * 1000) / 1000;
  lines.push(`Live data differs by **${d(drift)} pp** on result and ` +
    `**${d(base.winRate - BASE_WIN)} pp** on win rate.`);
  lines.push('');

  // ── Причины выхода ───────────────────────────────────────────────────
  // Поле why писалось с самого начала и никуда не показывалось. Разбивка
  // меняет вывод: масса TIME значит, что цель недостижима, масса SL — что
  // стоп стоит в рабочей зоне, а не в аварийной.
  const exits = (meta && meta.exits) || [];
  if (exits.length) {
    const by = { TP: 0, SL: 0, TIME: 0, other: 0 };
    for (const e of exits) by[e.why] !== undefined ? by[e.why]++ : by.other++;
    const pct = (v) => Math.round(v / exits.length * 100);
    lines.push('## How trades ended');
    lines.push('');
    lines.push(`- Hit target: **${by.TP}** (${pct(by.TP)}%)`);
    lines.push(`- Hit stop: **${by.SL}** (${pct(by.SL)}%)`);
    lines.push(`- Closed on the 48h limit: **${by.TIME}** (${pct(by.TIME)}%)`);
    if (by.TIME > exits.length * 0.3) {
      lines.push('');
      lines.push('More than a third timed out, which means the target is out of reach for');
      lines.push('these entries rather than merely slow. Test a lower one below.');
    }
    if (by.SL > exits.length * 0.25) {
      lines.push('');
      lines.push('The stop is firing on a quarter of trades or more. It was sized as');
      lines.push('catastrophe insurance, not as a working exit — check whether it now sits');
      lines.push('inside normal noise for these coins.');
    }
    lines.push('');

    // ── Что дала бы другая цель и другой стоп ──────────────────────────
    const fee = (meta && meta.feePct) || 0.25;
    const sweep = sweepTargets(exits, fee,
      [0.8, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0], [0, 3, 4, 6, 8]);
    if (sweep.rows.length) {
      lines.push('## What other targets and stops would have produced');
      lines.push('');
      lines.push(`Reconstructed from the peak and trough recorded on each of the ${sweep.n} live`);
      lines.push('trades, not from a backtest. These are the same trades, re-scored: if the');
      lines.push('trough went past a stop it is counted as stopped, otherwise if the peak');
      lines.push('reached a target it is counted as a win. Peak and trough do not record the');
      lines.push('ORDER of the two, so a trade that hit both is counted as stopped — the');
      lines.push('numbers lean pessimistic rather than flattering.');
      lines.push('');
      lines.push('| Target | Stop | Expectancy | Wins | Reached target | Stopped |');
      lines.push('|---|---|---|---|---|---|');
      const best = sweep.rows.slice().sort((a, b) => b.exp - a.exp)[0];
      for (const r of sweep.rows.slice().sort((a, b) => b.exp - a.exp).slice(0, 12)) {
        const mark = r === best ? ' **←**' : '';
        lines.push(`| +${r.tp}% | ${r.sl ? '-' + r.sl + '%' : 'none'} | **${d(r.exp)}%** | ${r.winRate}% | ${r.tpShare}% | ${r.slShare}% |${mark}`);
      }
      lines.push('');
      const cur = sweep.rows.find(r => r.tp === (meta.targetPct || 2) && r.sl === (meta.slPct || 6));
      if (cur && best && best.exp > cur.exp) {
        lines.push(`Live data prefers **+${best.tp}% / ${best.sl ? '-' + best.sl + '%' : 'no stop'}** ` +
          `(${d(best.exp)}%) over the current **+${cur.tp}% / -${cur.sl}%** (${d(cur.exp)}%), ` +
          `a difference of **${d(Math.round((best.exp - cur.exp) * 1000) / 1000)} pp** per trade.`);
        lines.push('Confirm on history before changing anything — this sample is one market regime.');
      } else if (cur) {
        lines.push(`The current **+${cur.tp}% / -${cur.sl}%** is the best combination in this sample.`);
      }
      lines.push('');
    }
  }

  // ── Насколько зажат гейт ─────────────────────────────────────────────
  // Группа «не хватило ДВУХ условий»: она отвечает не на вопрос «нужно ли
  // условие», а на вопрос «сколько прибыльных входов мы вообще не видим».
  const far = meta && meta.farGroup;
  if (far && far.n >= 5) {
    lines.push('## How much the gate is leaving on the table');
    lines.push('');
    lines.push('Trades that missed TWO conditions — never eligible, tracked only to see');
    lines.push('what lies outside the gate entirely.');
    lines.push('');
    lines.push(`- ${far.n} trades, ${far.winRate}% wins, **${d(far.avgPct)}%** per trade` +
      (base ? ` against **${d(base.avgPct)}%** for trades that passed` : ''));
    if (base && far.avgPct > base.avgPct) {
      lines.push('');
      lines.push('Entries the gate rejects outright are doing BETTER than the ones it lets');
      lines.push('through. If this holds past 20 trades the gate is over-tightened, and the');
      lines.push('pairs below say where to look first.');
    }
    if (far.pairs && far.pairs.length) {
      lines.push('');
      lines.push('| Missing pair | Trades | Wins | Average |');
      lines.push('|---|---|---|---|');
      for (const p of far.pairs) lines.push(`| ${p.cond} | ${p.n} | ${p.winRate}% | ${d(p.avgPct)}% |`);
    }
    lines.push('');
  }

  // Проверка условий по контрольной группе — работает раньше разрезов,
  // потому что требует меньше данных
  const conds = (meta && meta.conditions) || [];
  const ready = conds.filter(c => c.enough);
  if (ready.length) {
    lines.push('## Testing each gate condition');
    lines.push('');
    lines.push('The control group is trades that missed EXACTLY ONE condition. If results');
    lines.push('without a condition are no worse, that condition only throttles entry flow.');
    lines.push('');
    lines.push('| Condition | Trades missing it | Wins | Average | vs passers | Verdict |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of ready) {
      lines.push(`| ${c.cond} | ${c.n} | ${c.winRate}% | ${d(c.avgPct)}% | **${d(c.delta)} pp** | ${c.verdict} |`);
    }
    lines.push('');
    const useless = ready.filter(c => c.verdict !== 'earns its place');
    if (useless.length) {
      lines.push('**Candidates to relax:**');
      useless.forEach(c => lines.push(`- \`${c.cond}\` — without it ${d(c.delta)} pp. Check on history what ` +
        `removing or loosening the threshold would do.`));
      lines.push('');
    }
  } else if (conds.length) {
    lines.push('## Condition testing');
    lines.push('');
    lines.push('Control group still filling: ' + conds.map(c => `${c.cond} — ${c.n}`).join(', ') +
      '. Needs at least 6 trades per condition.');
    lines.push('');
  }

  if (!enough) {
    lines.push('## Conclusions');
    lines.push('');
    const cls = clusterStats(trades);
    if (cls && base.n >= 15 && cls.nClusters < 4) {
      lines.push(`There are ${base.n} gate trades, which looks like enough, but they came from`);
      lines.push(`only **${cls.nClusters} bursts** — ${cls.nClusters} independent observations, not ${base.n}.`);
      lines.push('Slicing this sample would find properties of one market move and report them');
      lines.push('as properties of the gate. Waiting for at least 4 separate bursts.');
    } else {
      lines.push(`Only ${base.n} gate trades so far; slicing needs at least 15.`);
    }
    if (!ready.length) lines.push('The control group has not filled either. Let it accumulate.');
    else lines.push('But the condition test above already works — start there.');
    return lines.join('\n');
  }

  if (!observations.length) {
    lines.push('## Conclusions');
    lines.push('');
    lines.push('No slice deviates by 0.25 pp or more from the overall average. The gate');
    lines.push('performs the same across every measured condition, so there is nothing to');
    lines.push('narrow yet. Keep accumulating trades.');
    return lines.join('\n');
  }

  lines.push('## Deviations found');
  lines.push('');
  lines.push('| Slice | Group | Trades | Wins | Average | Deviation |');
  lines.push('|---|---|---|---|---|---|');
  for (const o of observations.slice(0, 12)) {
    lines.push(`| ${o.dim} | ${o.group} | ${o.n} | ${o.winRate}% | ${d(o.avgPct)}% | **${d(o.delta)} pp** |`);
  }
  lines.push('');
  lines.push('## Suggested work');
  lines.push('');
  let i = 1;
  for (const o of observations.slice(0, 6)) {
    if (o.delta < 0) {
      lines.push(`${i++}. **${o.dim} — "${o.group}" performs worse** (${o.n} trades, ${o.winRate}% wins, ${d(o.avgPct)}%, which is ${d(o.delta)} pp off the average).`);
      lines.push(`   Check on history whether to exclude such entries or score them lower.`);
    } else {
      lines.push(`${i++}. **${o.dim} — "${o.group}" performs better** (${o.n} trades, ${o.winRate}% wins, ${d(o.avgPct)}%, which is ${d(o.delta)} pp off the average).`);
      lines.push(`   Check whether to score such entries higher or make the condition mandatory.`);
    }
    lines.push('');
  }
  lines.push('## Hard requirement');
  lines.push('');
  lines.push('Run every change against historical data first');
  lines.push('(`node src/scalp/backtest.js 7 500000`) and check stability across three time');
  lines.push('segments. Do not accept changes that improve only the overall result but do');
  lines.push('not hold across segments — that already happened with the "signal age" idea');
  lines.push('and with the EMA9 exit.');
  lines.push('');
  lines.push('One more trap worth naming: measure candidate filters against the CURRENT');
  lines.push('live gate, not an older one. A daily-range filter looked like a clear win');
  lines.push('against the pre-pump-filter gate and turned out to be worth nothing once the');
  lines.push('range and run-up conditions were already in place — it was removing trades');
  lines.push('they had already removed.');
  lines.push('');
  lines.push('The sample is small and covers one market regime. This is a pointer to where');
  lines.push('to look, not a finished answer.');
  return lines.join('\n');
}

/**
 * Проверка каждого условия гейта по контрольной группе.
 *
 * Контроль — сделки, которым не хватило РОВНО ОДНОГО условия. Если такие
 * сделки идут не хуже прошедших, значит это условие ничего не добавляет и
 * только режет поток входов. Понять это по одним лишь прошедшим невозможно.
 */
function checkConditions(passed, shadows, minN = 6) {
  const base = agg(passed);
  if (!base) return [];
  const byMissing = {};
  for (const t of shadows) {
    const k = t.missing || '—';
    (byMissing[k] || (byMissing[k] = [])).push(t);
  }
  return Object.entries(byMissing)
    .map(([cond, arr]) => {
      const a = agg(arr);
      if (!a || a.n < minN) return { cond, n: a ? a.n : 0, enough: false };
      const delta = Math.round((a.avgPct - base.avgPct) * 1000) / 1000;
      return {
        cond, enough: true, n: a.n, winRate: a.winRate, avgPct: a.avgPct,
        baseWin: base.winRate, baseAvg: base.avgPct, delta,
        // условие оправдано, если без него заметно хуже
        verdict: delta <= -0.15 ? 'earns its place' : delta >= 0.15 ? 'hurts' : 'no effect',
      };
    })
    .sort((a, b) => (b.n || 0) - (a.n || 0));
}

module.exports = { BUCKETS, agg, findObservations, buildBrief, checkConditions, sweepTargets, aggFar, clusters, clusterStats };
