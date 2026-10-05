// РАЗГОН ЗА МЕСЯЦ — риск, которого рейтинг отката не видит.
//
// Рейтинг меряет сутки: падение от суточного максимума и откат за полчаса.
// Монета, которая за две недели выросла в разы, в нём выглядит как обычный
// часовой откат: в рейтинге «−10% от пика», хотя до уровня, с которого
// начинался разгон, может оставаться больше половины цены.
//
// Это пометка риска, а не замер и не условие покупки: гейт, баллы и
// разрешение на вход она не трогает. Порог «вдвое» выбран для отображения,
// его доходность не проверялась — так и подписано на экране.
//
// Свечи Coinbase приходят новыми вперёд: [time, low, high, open, close, volume].
'use strict';

const PUMP_RUNUP = 2;          // во сколько раз выросла цена за окно, чтобы показать пометку
const PUMP_DAYS = 30;

function pumpFromDaily(candles, price) {
  if (!Array.isArray(candles) || !(Number(price) > 0)) return null;
  const rows = candles.slice(0, PUMP_DAYS)
    .map(c => ({ t: Number(c[0]), lo: Number(c[1]), hi: Number(c[2]) }))
    .filter(c => Number.isFinite(c.t) && c.lo > 0 && c.hi >= c.lo)
    .sort((a, b) => a.t - b.t);
  // Меньше десяти дней — истории мало, «разгон» по ней не отличить от шума.
  // Неизвестно — значит пометки нет и в подсказке так и сказано, а не «всё спокойно».
  if (rows.length < 10) return null;
  let peakIdx = 0;
  rows.forEach((c, i) => { if (c.hi > rows[peakIdx].hi) peakIdx = i; });
  const peak = rows[peakIdx].hi;
  // База — минимум ДО пика: уровень, с которого начинался рост.
  const base = Math.min(...rows.slice(0, peakIdx + 1).map(c => c.lo));
  if (!(base > 0) || !(peak > base)) return null;
  const runup = peak / base;
  const lastT = rows[rows.length - 1].t;
  return {
    runup: Math.round(runup * 10) / 10,
    base, peak, days: rows.length,
    peakDaysAgo: Math.max(0, Math.round((lastT - rows[peakIdx].t) / 86400)),
    // Сколько ещё до базы от текущей цены (отрицательное — ниже текущей).
    toBasePct: Math.round((base / price - 1) * 1000) / 10,
    // Какую долю роста цена уже отдала: 0% — на пике, 100% — вернулась к базе.
    givenBackPct: Math.round(Math.min(100, Math.max(0, (peak - price) / (peak - base) * 100))),
    pumped: runup >= PUMP_RUNUP && price > base,
  };
}

module.exports = { pumpFromDaily, PUMP_RUNUP, PUMP_DAYS };
