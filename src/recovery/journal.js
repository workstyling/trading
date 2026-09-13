'use strict';

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const finite = value => value != null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
const round = (value, digits = 3) => value == null ? null : Number(value.toFixed(digits));
const mean = values => values.length ? values.reduce((s, x) => s + x, 0) / values.length : null;
const markout = t => finite(t.m60) ? Number(t.m60) : null;
const hitValue = t => finite(t.hit60) ? 100 : t.hitKnown60 === true ? 0 : null;
const hour = t => Math.floor(Number(t.at) / HOUR);

// Influence sums retain each trade's weight in the reported mean. Averaging
// scan means first estimates a different quantity when scan sizes differ.
function influences(list, pick, key) {
  const rows = list.filter(t => finite(t.at) && finite(pick(t)));
  const avg = mean(rows.map(pick));
  const scores = new Map();
  for (const t of rows) scores.set(key(t), (scores.get(key(t)) || 0) + (pick(t) - avg) / rows.length);
  return { rows, avg, scores };
}

function scoreError(scores, hourly = false) {
  if (scores.size < 2) return null;
  const diagonal = [...scores.values()].reduce((s, x) => s + x * x, 0);
  let variance = diagonal;
  if (hourly) {
    // Bartlett HAC, two hourly lags. Missing hours remain gaps, not neighbours.
    // Keep the larger of cluster-only and HAC variance for this diagnostic.
    for (let lag = 1; lag <= 2; lag++) {
      let covariance = 0;
      for (const [at, value] of scores) covariance += value * (scores.get(at - lag) || 0);
      variance += 2 * (1 - lag / 3) * covariance;
    }
  }
  return Math.sqrt(Math.max(diagonal, variance, 0) * scores.size / (scores.size - 1));
}

function summarize(list) {
  if (!list.length) return null;
  const m = influences(list, markout, t => t.at);
  const times = influences(list, markout, hour);
  const hits = influences(list, hitValue, t => t.at);
  const hitTimes = influences(list, hitValue, hour);
  const values = m.rows.map(markout);
  const sd = values.length > 1
    ? Math.sqrt(values.reduce((s, x) => s + (x - m.avg) ** 2, 0) / (values.length - 1)) : null;
  const avgField = (rows, field) => round(mean(rows.filter(t => finite(t[field])).map(t => Number(t[field]))));
  return {
    n: list.length, m60n: values.length, m60Unknown: list.length - values.length,
    m5: avgField(list, 'm5'), m15: avgField(list, 'm15'), m60: round(m.avg),
    m60sd: round(sd), m60se: round(sd == null ? null : sd / Math.sqrt(values.length)),
    m60seScan: round(scoreError(m.scores)), m60seHour: round(scoreError(times.scores, true)),
    scans: m.scores.size, hours: times.scores.size,
    hitHour: round(hits.avg, 1), hitN: hits.rows.length, hitUnknown: list.length - hits.rows.length,
    hitHourSeScan: round(scoreError(hits.scores), 1), hitHourSeHour: round(scoreError(hitTimes.scores, true), 1),
    m60Hit: avgField(list.filter(t => hitValue(t) === 100), 'm60'),
    m60NoHit: avgField(list.filter(t => hitValue(t) === 0), 'm60'),
    mae: avgField(list, 'mae60'),
  };
}

function comparison(main, control, pick = markout) {
  const a = main.filter(t => finite(t.at) && finite(pick(t)));
  const b = control.filter(t => t.cv === 2 && finite(t.at) && finite(pick(t)));
  const bHours = new Set(b.map(hour));
  const shared = new Set(a.map(hour).filter(at => bHours.has(at)));
  const left = a.filter(t => shared.has(hour(t)));
  const right = b.filter(t => shared.has(hour(t)));
  const x = influences(left, pick, hour), y = influences(right, pick, hour);
  const scores = new Map([...shared].map(at => [at, x.scores.get(at) - y.scores.get(at)]));
  const diff = x.avg == null || y.avg == null ? null : x.avg - y.avg;
  const se = scoreError(scores, true);
  return {
    main: summarize(left), control: summarize(right),
    mainMean: round(x.avg), controlMean: round(y.avg), diff: round(diff), se: round(se),
    hours: shared.size, n: left.length, controlN: right.length,
    excludedMain: main.length - left.length, excludedControl: control.length - right.length,
    since: shared.size ? Math.min(...shared) * HOUR : null,
    until: shared.size ? (Math.max(...shared) + 1) * HOUR : null,
    significant: shared.size >= 25 && se != null && diff != null && Math.abs(diff) > 2 * se,
    method: 'trade-weighted / common UTC hours / Bartlett HAC 2 / 1SE',
  };
}

function assessTake(take, controls) {
  const checked = take.filter(t => t.outcomeVersion === 4);
  const checkedControl = controls.filter(t => t.outcomeVersion === 4);
  const c = comparison(checked, checkedControl);
  const out = {
    needN: 40, needScans: 25, needHours: 25, needControl: 30, giveUpN: 120,
    haveN: c.n, haveScans: c.main ? c.main.scans : 0, haveHours: c.hours,
    controlN: c.controlN, recordedN: take.length, pending: take.length - checked.length,
    diff: c.diff, se: c.se, state: 'ждём', comparison: c,
  };
  if (c.n < out.needN || c.hours < out.needHours || c.controlN < out.needControl || c.se == null) {
    out.why = 'сопоставимых исходов «брать» ' + c.n + '/' + out.needN + ', часов ' + c.hours + '/' + out.needHours +
      ', контроль ' + c.controlN + '/' + out.needControl;
  } else if (c.significant) {
    out.state = c.diff > 0 ? 'лучше контроля' : 'хуже контроля';
    out.why = 'исход часа без издержек: разница ' + c.diff + ' ±' + c.se + ' п.п.; это оценка всего правила';
  } else if (c.n >= out.giveUpN) {
    out.state = 'преимущество не подтверждено';
    out.why = c.n + ' сопоставимых исходов, разница ' + c.diff + ' ±' + c.se + ' п.п.';
  } else {
    out.why = 'разница ' + c.diff + ' ±' + c.se + ' п.п., в пределах погрешности';
  }
  return out;
}

function forecastCells(list, odds) {
  const rows = [];
  for (const [lo, hi] of [[0, 1], [1, 3], [3, 6], [6, 10], [10, Infinity]]) {
    for (const deep of [false, true]) {
      const selected = list.filter(t => finite(t.dayFall) && finite(t.pullback) &&
        t.dayFall >= lo && t.dayFall < hi && (t.pullback >= 1.5) === deep);
      if (!selected.length) continue;
      const known = selected.filter(t => hitValue(t) != null);
      const current = odds(lo, deep ? 1.5 : 0);
      const promised = known.filter(t => finite(t.recHourAtOpen ?? t.recHour));
      const promises = promised.map(t => Number(t.recHourAtOpen ?? t.recHour));
      rows.push({
        label: (hi === Infinity ? lo + '%+' : lo + '–' + hi + '%') + (deep ? ' / откат ≥1.5%' : ' / откат <1.5%'),
        n: known.length, recordedN: selected.length, unknown: selected.length - known.length,
        promised: round(mean(promises), 1), promisedN: promised.length,
        actual: selected.length === known.length ? round(mean(promised.map(hitValue)), 1) : null,
        actualAll: selected.length === known.length ? round(mean(known.map(hitValue)), 1) : null,
        actualLow: round(selected.filter(t => hitValue(t) === 100).length / selected.length * 100, 1),
        actualHigh: round((selected.filter(t => hitValue(t) === 100).length + selected.length - known.length) / selected.length * 100, 1),
        current: current ? current.hour : null,
      });
    }
  }
  return rows;
}

// Only full candles after the entry are eligible. An observed target is known
// even in a sparse series; absence of a target is unknown if candles are missing.
function candleOutcome(trade, raw, needPct = 0.30) {
  const at = Number(trade.at), entry = Number(trade.entry);
  if (!finite(trade.at) || !(entry > 0)) throw new Error('invalid journal entry');
  const end = at + HOUR;
  const first = Math.ceil(at / MINUTE) * MINUTE;
  const lastEnd = Math.floor(end / MINUTE) * MINUTE;
  const byTime = new Map();
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!Array.isArray(row)) continue;
    const [seconds, lo, hi, , cl] = row.map(Number);
    const t = seconds * 1000;
    if (Number.isFinite(t) && t % MINUTE === 0 && t >= first && t < end &&
        lo > 0 && hi >= lo && cl >= lo && cl <= hi) byTime.set(t, { t, lo, hi, cl });
  }
  const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
  const priceAt = minutes => {
    const wanted = at + minutes * MINUTE;
    const known = candles.filter(c => c.t + MINUTE <= wanted && wanted - c.t - MINUTE < 90 * 1000);
    return known.length ? round((known[known.length - 1].cl / entry - 1) * 100, 2) : null;
  };
  let complete = true;
  for (let t = first; t < lastEnd; t += MINUTE) if (!byTime.has(t)) complete = false;
  let hit = null, worst = 0;
  for (const c of candles) {
    if (c.t + MINUTE > end) break;
    worst = Math.min(worst, (c.lo / entry - 1) * 100);
    if (c.hi >= entry * (1 + needPct / 100)) { hit = round((c.t + MINUTE - at) / MINUTE, 1); break; }
  }
  return {
    m5: priceAt(5), m15: priceAt(15), m60: priceAt(60), hit60: hit,
    hitKnown60: hit != null || complete, hourComplete: complete,
    mae60: hit != null || complete ? round(worst, 2) : null,
    outcomeVersion: 4,
  };
}

module.exports = { finite, summarize, comparison, assessTake, forecastCells, candleOutcome };
