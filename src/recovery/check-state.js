'use strict';
const {freshRecoveryReport} = require('../../public/js/recovery-journal');
const RETRY_MS = 30 * 60 * 1000;
const INTERRUPTED_MS = 40 * 60 * 1000;

function usableCheck(stamp, now = stamp.at) {
  return !!freshRecoveryReport({...stamp, current: stamp.version === 2}, now);
}

function nextCheckAt(stamp, everyHours = 22) {
  const finished = stamp.lastAttempt?.at || stamp.at || 0;
  // A completed failure uses the retry delay; the longer lock is only for a
  // child interrupted by a restart, with no recorded completion.
  if ((stamp.startedAt || 0) > finished) return stamp.startedAt + INTERRUPTED_MS;
  if (stamp.version !== 2) return 0;
  const failed = stamp.lastAttempt ? !stamp.lastAttempt.ok : !usableCheck(stamp);
  return finished + (failed ? RETRY_MS : everyHours * 3600000);
}

function finishCheck(previous, {report, code, startedAt, at, error}) {
  const result = {version: 2, at, code, report, mins: Math.round((at - startedAt) / 60000)};
  const ok = usableCheck(result);
  // Never relabel the old report with a new timestamp. Its original freshness
  // limit continues to apply, including after a failed refresh.
  const retained = !ok && usableCheck(previous, at) ? previous : result;
  return {...retained, startedAt, lastAttempt: {at, code, mins: result.mins, ok,
    error: ok ? null : String(error || 'Проверка завершилась без пригодного отчёта.').slice(0, 240)}};
}

module.exports = {usableCheck, nextCheckAt, finishCheck};
