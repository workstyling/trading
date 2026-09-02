const fs = require('fs');

function isFiniteNumber(value) {
  return Number.isFinite(value);
}

function aggregate(trades) {
  const rows = Array.isArray(trades) ? trades.filter(trade => isFiniteNumber(trade && trade.pnlPct)) : [];
  if (!rows.length) return { n: 0, wins: 0, winRate: null, avgPct: null, totalPnl: 0, avgHoldMin: null };
  const wins = rows.filter(trade => trade.pnlPct > 0).length;
  return {
    n: rows.length,
    wins,
    winRate: Math.round(wins / rows.length * 100),
    avgPct: Math.round(rows.reduce((sum, trade) => sum + trade.pnlPct, 0) / rows.length * 1000) / 1000,
    totalPnl: Math.round(rows.reduce((sum, trade) => sum + (Number(trade.pnl) || 0), 0) * 100) / 100,
    avgHoldMin: Math.round(rows.reduce((sum, trade) => sum + (Number(trade.holdMin) || 0), 0) / rows.length * 10) / 10,
  };
}

function createMicroLab(options) {
  const {
    file,
    runtimeFingerprint,
    getDiskFingerprint,
    getExecution,
    fetchQuote,
    maxOpen = 3,
    maxEntrySpreadPct = 0.2,
    burstGapMs = 10 * 60 * 1000,
    cooldownMs = 90 * 60 * 1000,
    log = () => {},
  } = options || {};
  if (!file || !runtimeFingerprint || typeof getDiskFingerprint !== 'function' ||
      typeof getExecution !== 'function' || typeof fetchQuote !== 'function') {
    throw new Error('Micro lab requires persistence, fingerprints, execution, and quote providers');
  }

  let state = {
    schemaVersion: 1,
    enabled: true,
    startedAt: Date.now(),
    budget: 1000,
    cohortId: null,
    fingerprint: null,
    executionSignature: null,
    trades: [],
    generations: [],
  };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { }

  function executionSignature(execution = getExecution()) {
    return [execution.targetPct, execution.slPct, execution.maxHoldMin, execution.feePct, execution.executionModel].join('|');
  }
  function cohortId(fingerprint, signature, at = Date.now()) {
    return `${fingerprint || 'unknown'}:${signature || 'unknown'}:${at}`;
  }
  function runtime() {
    const diskFingerprint = getDiskFingerprint();
    const matched = !!runtimeFingerprint && runtimeFingerprint === diskFingerprint;
    return {
      matched,
      state: matched ? 'ready' : 'restart_required',
      runtimeFingerprint: runtimeFingerprint || null,
      diskFingerprint: diskFingerprint || null,
    };
  }
  function isCurrent(trade) {
    return !!(trade && !trade.archivedAt && trade.cohortId === state.cohortId);
  }
  function executionFor(trade) {
    const fallback = getExecution();
    return {
      targetPct: isFiniteNumber(trade && trade.targetPct) ? trade.targetPct : fallback.targetPct,
      slPct: isFiniteNumber(trade && trade.slPct) ? trade.slPct : fallback.slPct,
      maxHoldMin: isFiniteNumber(trade && trade.maxHoldMin) ? trade.maxHoldMin : fallback.maxHoldMin,
      feePct: isFiniteNumber(trade && trade.feePct) ? trade.feePct : fallback.feePct,
      executionModel: trade && trade.executionModel || fallback.executionModel,
    };
  }
  function pnl(trade, exit) {
    const execution = executionFor(trade);
    if (!(trade && trade.entry > 0 && trade.budget > 0 && exit > 0)) return null;
    const quantity = isFiniteNumber(trade.qty) ? trade.qty : trade.budget * (1 - execution.feePct) / trade.entry;
    return Math.round((quantity * exit * (1 - execution.feePct) - trade.budget) * 100) / 100;
  }
  function save() {
    let temporary = null;
    try {
      temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(temporary, file);
    } catch (error) {
      if (temporary) { try { fs.unlinkSync(temporary); } catch { } }
      log('save error: ' + error.message);
    }
  }
  function normalize() {
    let changed = false;
    if (!Array.isArray(state.trades)) { state.trades = []; changed = true; }
    if (!Array.isArray(state.generations)) { state.generations = []; changed = true; }
    if (state.schemaVersion !== 1) { state.schemaVersion = 1; changed = true; }
    if (!isFiniteNumber(state.budget) || state.budget <= 0) { state.budget = 1000; changed = true; }
    if (!isFiniteNumber(state.startedAt) || state.startedAt <= 0) { state.startedAt = Date.now(); changed = true; }
    const execution = getExecution();
    for (const trade of state.trades) {
      if (!trade.cohortId) { trade.cohortId = state.cohortId || 'legacy'; changed = true; }
      for (const [key, value] of Object.entries(execution)) {
        if (trade[key] == null) { trade[key] = value; changed = true; }
      }
    }
    return changed;
  }
  function reconcile() {
    const status = runtime();
    const execution = getExecution();
    const signature = executionSignature(execution);
    if (!status.matched) return { changed: false, entriesAllowed: false, runtime: status };
    const needsNew = state.fingerprint !== status.runtimeFingerprint ||
      state.executionSignature !== signature || !state.cohortId;
    if (!needsNew) return { changed: false, entriesAllowed: true, runtime: status };

    const now = Date.now();
    const prior = state.trades.filter(isCurrent);
    if (prior.length) {
      const closed = prior.filter(trade => trade.closedAt);
      state.generations.push({
        at: now,
        cohortId: state.cohortId,
        fingerprint: state.fingerprint || null,
        executionSignature: state.executionSignature || null,
        trades: closed.length,
        openAtArchive: prior.filter(trade => !trade.closedAt).length,
        stats: aggregate(closed),
        reason: 'strategy code or paper execution changed',
      });
      for (const trade of prior) {
        trade.archivedAt = now;
        trade.archivedReason = 'strategy code or paper execution changed';
      }
    }
    state.fingerprint = status.runtimeFingerprint;
    state.executionSignature = signature;
    state.cohortId = cohortId(status.runtimeFingerprint, signature, now);
    state.startedAt = now;
    return { changed: true, entriesAllowed: true, runtime: status };
  }
  function burstId(openedAt) {
    const latest = state.trades
      .filter(trade => trade.cohortId === state.cohortId && trade.burstId && isFiniteNumber(trade.openedAt) &&
        trade.openedAt <= openedAt && openedAt - trade.openedAt <= burstGapMs)
      .sort((left, right) => right.openedAt - left.openedAt)[0];
    return latest ? latest.burstId : `micro_${state.cohortId}_${openedAt}`;
  }
  function closeTrade(trade, exit, why, quote) {
    trade.exit = exit;
    trade.closedAt = Date.now();
    trade.why = why;
    trade.exitObservedBid = quote.bid;
    trade.exitObservedBidAt = quote.at;
    trade.pnl = pnl(trade, exit);
    trade.pnlPct = trade.pnl != null ? Math.round(trade.pnl / trade.budget * 10000) / 100 : null;
    trade.holdMin = Math.round((trade.closedAt - trade.openedAt) / 60000 * 10) / 10;
    log(`${trade.coin} ${why}: ${trade.pnlPct}%`);
  }
  function canEnter(results, scanAt) {
    if (!state.enabled || !scanAt || Date.now() < scanAt || Date.now() - scanAt > 3 * 60 * 1000) return [];
    const open = state.trades.filter(trade => !trade.closedAt && isCurrent(trade));
    if (open.length >= maxOpen) return [];
    return (results || []).filter(result => result && result.pass).slice(0, Math.max(0, maxOpen - open.length));
  }
  async function tick({ results, scanAt }) {
    let changed = false;
    const cohort = reconcile();
    changed = changed || cohort.changed;

    for (const trade of state.trades.filter(item => !item.closedAt)) {
      try {
        const execution = executionFor(trade);
        const quote = await fetchQuote(trade.pair);
        if (!quote || !(quote.bid > 0)) continue;
        trade.last = quote.bid;
        trade.lastBidAt = quote.at;
        const grossPct = (quote.bid / trade.entry - 1) * 100;
        const observed = Math.round(grossPct * 100) / 100;
        trade.mfe = trade.mfe == null ? observed : Math.max(trade.mfe, observed);
        trade.mae = trade.mae == null ? observed : Math.min(trade.mae, observed);
        const dueAt = trade.openedAt + execution.maxHoldMin * 60000;
        const target = trade.entry * (1 + execution.targetPct / 100);
        if (quote.at >= dueAt) closeTrade(trade, quote.bid, 'TIME', quote);
        else if (grossPct >= execution.targetPct) closeTrade(trade, target, 'TP', quote);
        else if (grossPct <= -execution.slPct) closeTrade(trade, quote.bid, 'SL', quote);
        changed = true;
      } catch (error) {
        log('ticker ' + trade.coin + ': ' + error.message);
      }
    }

    if (cohort.entriesAllowed) {
      for (const candidate of canEnter(results, scanAt)) {
        if (state.trades.some(trade => trade.coin === candidate.coin && !trade.closedAt)) continue;
        const recent = [...state.trades].reverse().find(trade => trade.coin === candidate.coin && trade.closedAt);
        if (recent && Date.now() - recent.closedAt < cooldownMs) continue;
        const quote = await fetchQuote(candidate.pair);
        if (!quote || !(quote.ask > 0) || !(quote.bid > 0) || quote.bid > quote.ask || quote.spreadPct > maxEntrySpreadPct) continue;
        const execution = getExecution();
        const now = Date.now();
        const initialPct = Math.round((quote.bid / quote.ask - 1) * 10000) / 100;
        state.trades.push({
          id: `micro_${now}_${candidate.coin}`,
          coin: candidate.coin,
          pair: candidate.pair,
          entry: quote.ask,
          entryBid: quote.bid,
          entrySpreadPct: quote.spreadPct,
          entryQuoteAt: quote.at,
          last: quote.bid,
          lastBidAt: quote.at,
          qty: state.budget * (1 - execution.feePct) / quote.ask,
          budget: state.budget,
          openedAt: now,
          cohortId: state.cohortId,
          fingerprint: runtimeFingerprint,
          burstId: burstId(now),
          targetPct: execution.targetPct,
          slPct: execution.slPct,
          maxHoldMin: execution.maxHoldMin,
          feePct: execution.feePct,
          executionModel: execution.executionModel,
          mfe: initialPct,
          mae: initialPct,
          ctx: {
            score: candidate.score,
            rsi: candidate.rsi,
            pullbackPct: candidate.pullbackPct,
            volumeX: candidate.volumeX,
            spreadPct: quote.spreadPct,
            vol24: candidate.vol24,
            checks: (candidate.checks || []).map(check => ({ k: check.k, ok: !!check.ok })),
          },
        });
        changed = true;
        log(`paper setup ${candidate.coin} @ $${quote.ask}`);
      }
    }
    if (changed) save();
  }
  function payload() {
    const cohort = reconcile();
    if (cohort.changed) save();
    const currentClosed = state.trades.filter(trade => trade.closedAt && isCurrent(trade));
    const archivedClosed = state.trades.filter(trade => trade.closedAt && !isCurrent(trade));
    const open = state.trades.filter(trade => !trade.closedAt).map(trade => {
      const value = isFiniteNumber(trade.last) ? pnl(trade, trade.last) : null;
      return {
        ...trade,
        pnl: value,
        pnlPct: value != null ? Math.round(value / trade.budget * 10000) / 100 : null,
        isCurrent: isCurrent(trade),
      };
    });
    const currentOpen = open.filter(trade => trade.isCurrent);
    const bursts = new Set(currentClosed.map(trade => trade.burstId).filter(Boolean));
    return {
      success: true,
      enabled: state.enabled,
      entryBlocked: !cohort.entriesAllowed,
      runtime: cohort.runtime,
      cohort: { id: state.cohortId || null, fingerprint: state.fingerprint || null },
      execution: getExecution(),
      hoursRunning: Math.round((Date.now() - state.startedAt) / 3600000 * 10) / 10,
      open: currentOpen,
      currentOpenCount: currentOpen.length,
      closed: currentClosed.slice(-30).reverse(),
      currentClosedCount: currentClosed.length,
      archivedClosedCount: archivedClosed.length,
      stats: aggregate(currentClosed),
      bursts: bursts.size,
      generations: state.generations.slice(-8).reverse(),
    };
  }

  const dirty = normalize();
  const initial = reconcile();
  if (dirty || initial.changed) save();
  return { tick, payload, runtime, aggregate };
}

module.exports = { createMicroLab, aggregate };
