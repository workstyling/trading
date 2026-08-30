/**
 * SCALP SCORE — a 2–6 hour structural candidate.
 *
 * Local conditions and trade authorization are separate: authorization requires
 * a matching result in scalp-gate-validation.json.
 */

const CB = 'https://api.exchange.coinbase.com';
const H = { headers: { 'User-Agent': 'trading-app/1.0' } };

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function ema(v, p) {
  if (v.length < p) return null;
  let e = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  const k = 2 / (p + 1);
  for (let i = p; i < v.length; i++) e = v[i] * k + e * (1 - k);
  return e;
}

/** Свечи 5m за последние сутки + производные сигналы */
// Дневные свечи держим в кеше на час: они меняются медленно, а тянуть их
// на каждый скан для сотни монет — лишние сто запросов каждые четыре минуты
// из общего с сервером лимита Coinbase.
const _dailyCache = new Map();   // coin -> { at, candles }
const DAILY_TTL = 60 * 60 * 1000;
async function fetchDaily(coin) {
  const hit = _dailyCache.get(coin);
  if (hit && Date.now() - hit.at < DAILY_TTL) return hit.candles;
  try {
    const r = await fetch(`${CB}/products/${coin}-USD/candles?granularity=86400`, H);
    if (!r.ok) return hit ? hit.candles : null;
    const raw = await r.json();
    if (!Array.isArray(raw)) return hit ? hit.candles : null;
    const c = raw.filter(x => Array.isArray(x) && x[4] > 0)
      .map(x => ({ t: x[0], high: x[2], close: x[4] }))
      .sort((a, b) => a.t - b.t);
    _dailyCache.set(coin, { at: Date.now(), candles: c });
    return c;
  } catch { return hit ? hit.candles : null; }
}

async function fetchScalpSignals(coin) {
  let raw = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${CB}/products/${coin}-USD/candles?granularity=300`, H);
      if (r.status === 429) { await new Promise(x => setTimeout(x, 500 * (a + 1))); continue; }
      if (!r.ok) return null;
      raw = await r.json();
      break;
    } catch { await new Promise(x => setTimeout(x, 250)); }
  }
  if (!Array.isArray(raw) || raw.length < 60) return null;
  const c = raw.filter(x => Array.isArray(x) && x[4] > 0)
    .map(x => ({ t: x[0], low: x[1], high: x[2], open: x[3], close: x[4], vol: x[5] }))
    .sort((a, b) => a.t - b.t);
  if (c.length < 60) return null;

  const closes = c.map(x => x.close);
  const i = c.length - 1;
  const px = closes[i];
  const rsi = rsiSeries(closes, 14);
  const rNow = rsi[i];
  const rWin = rsi.slice(Math.max(0, i - 12), i + 1).filter(v => v != null);
  const rMin = rWin.length ? Math.min(...rWin) : null;

  const win48 = c.slice(Math.max(0, i - 48));       // 4 часа
  const lo = Math.min(...win48.map(x => x.low));
  const hi = Math.max(...win48.map(x => x.high));
  const rangePos = hi > lo ? (px - lo) / (hi - lo) : 0.5;

  // Ширина диапазона и рост ДО него. «Дно диапазона», раздутого недавним
  // пампом, — это начало сдува, а не откат в тренде. Замер на 249 входах:
  //   диапазон < 8%      +0.544% против +0.418% базы, устойчиво 3/3
  //   рост до +15%       +0.56%   (умеренный рост даже помогает)
  //   рост свыше +15%    −0.44%   — ожидание уходит в минус
  const range4Pct = lo > 0 ? (hi - lo) / lo * 100 : null;
  const runUp24 = (c.length >= 289 && closes[i - 288] > 0)
    ? (closes[i - 48] / closes[i - 288] - 1) * 100
    : null;

  // Exact distance from the 4h high; the lab uses this as an observation,
  // so it must not approximate a percent change with range position.
  const dropFromHigh4Pct = hi > 0 ? (hi - px) / hi * 100 : null;
  // Насколько монета ниже своей вершины за 14 дней.
  //
  // Условие «не после пампа» смотрит только сутки, и монета, выросшая
  // неделю назад и с тех пор падающая, проходит его свободно: на суточном
  // горизонте там тихо. Но гейт покупает провалы, а в затяжном снижении
  // провал не откупается. Замер на 499 входах за 30 дней:
  //   база                       69% побед, +0.286%, PF 1.34
  //   не глубже 10% под вершиной 73% побед, +0.606%, PF 2.12, остаётся 56%
  // Улучшение на ВСЕХ трёх отрезках (+0.140, +0.202, +0.534), причём первый
  // отрезок из минуса выходит в плюс. Пороги 15% и 25% слабее (2/3), а
  // фильтры по падению за 3 и 7 дней не проходят вовсе — значит дело не в
  // «любой мере снижения», а именно в удалённости от вершины.
  let fromHigh14 = null;
  try {
    const daily = await fetchDaily(coin);
    if (Array.isArray(daily) && daily.length >= 15) {
      const win = daily.slice(-15);
      const hi14 = Math.max(...win.map(x => x.high));
      if (hi14 > 0) fromHigh14 = (px / hi14 - 1) * 100;
    }
  } catch { }

  const e9 = ema(closes, 9), e21 = ema(closes, 21);
  const vols = c.slice(Math.max(0, i - 48), i).map(x => x.vol);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const volX = avgVol > 0 ? c[i].vol / avgVol : 0;

  return {
    price: px,
    rsi5: rNow != null ? Math.round(rNow * 10) / 10 : null,
    rsiMin1h: rMin != null ? Math.round(rMin * 10) / 10 : null,
    rsiRecover: rMin != null && rNow != null && rMin < 30 && rNow > rMin + 3,
    rangePos: Math.round(rangePos * 100) / 100,
    range4Pct: range4Pct != null ? Math.round(range4Pct * 10) / 10 : null,
    dropFromHigh4Pct: dropFromHigh4Pct != null ? Math.round(dropFromHigh4Pct * 100) / 100 : null,
    runUp24: runUp24 != null ? Math.round(runUp24 * 10) / 10 : null,
    fromHigh14: fromHigh14 != null ? Math.round(fromHigh14 * 10) / 10 : null,
    low4h: lo, high4h: hi,
    ema9: e9, ema21: e21,
    aboveE9: e9 != null && px > e9,
    e9overE21: e9 != null && e21 != null && e9 > e21,
    volX: Math.round(volX * 100) / 100,
  };
}

/**
 * Structural score only. `pass` means that local checks pass; it is not
 * permission to enter until independent historical validation is attached.
 */
function calcScalpScore(s, vol24, spreadPct) {
  if (!s) return null;
  const liquid = vol24 >= 500e3;
  // A short target cannot assume that an unavailable ticker has a tight spread.
  // Unknown or malformed bid/ask is a failed entry check, never an approval.
  const spreadKnown = Number.isFinite(spreadPct) && spreadPct >= 0;
  const spreadOk = spreadKnown && spreadPct <= 0.4;
  // `k` — подпись в интерфейсе, `en` — та же проверка по-английски: задание
  // для Claude Code собирается на английском, и раньше туда протекала
  // кириллица, которая на пути через shell превращалась в мусор.
  const checks = [
    { k: 'У дна 4ч диапазона (<25%)', en: 'Bottom of 4h range (<25%)', ok: s.rangePos < 0.25, v: Math.round(s.rangePos * 100) + '%' },
    { k: 'RSI 5m вышел из ямы', en: 'RSI 5m recovering off its low', ok: !!s.rsiRecover, v: `${s.rsi5 ?? '—'} (мин 1ч ${s.rsiMin1h ?? '—'})` },
    { k: 'Цена выше EMA9 (5m)', en: 'Price above EMA9 (5m)', ok: !!s.aboveE9, v: s.aboveE9 ? 'да' : 'нет' },
    // Диапазон не раздут: «дно» растянутого пампом коридора — это сдув
    { k: 'Диапазон 4ч не шире 8%', en: '4h range no wider than 8%', ok: s.range4Pct != null && s.range4Pct < 8, v: s.range4Pct != null ? s.range4Pct + '%' : '—' },
    // И до него не было выброса: рост свыше +15% за сутки уводит ожидание в минус
    { k: 'Не после пампа (рост ≤15%)', en: 'Not after a pump (24h run-up <=15%)', ok: s.runUp24 == null || s.runUp24 <= 15, v: s.runUp24 != null ? (s.runUp24 >= 0 ? '+' : '') + s.runUp24 + '%' : '—' },
    // Не ловим падающий нож: монета, ушедшая далеко от своей двухнедельной
    // вершины, в снижении, а не в откате. Нет данных — не пропускаем, как и
    // с условием по режиму: отсутствие сведений это не разрешение.
    { k: 'Не глубже 10% под вершиной 14д', en: 'Within 10% of its 14-day high', ok: s.fromHigh14 != null && s.fromHigh14 >= -10, v: s.fromHigh14 != null ? s.fromHigh14 + '%' : 'нет данных' },
    { k: 'Ликвидность ≥ $500K', en: 'Liquidity >= $500K', ok: liquid, v: '$' + Math.round(vol24 / 1e3) + 'K' },
    { k: 'Спред проверен и ≤0.4%', en: 'Spread verified and <=0.4%', ok: spreadOk, v: spreadKnown ? spreadPct.toFixed(2) + '%' : 'нет данных' },
  ];
  const passed = checks.filter(x => x.ok).length;
  const allOk = passed === checks.length;

  let sc = 0;
  if (s.rangePos < 0.25) sc += 25; else if (s.rangePos < 0.4) sc += 10; else if (s.rangePos > 0.9) sc -= 5;
  if (s.rsiRecover) sc += 25;
  else if (s.rsi5 != null && s.rsi5 < 30) sc += 5;      // ещё в яме — рано
  if (s.aboveE9) sc += 25;
  if (vol24 >= 2e6) sc += 15; else if (vol24 >= 1e6) sc += 13; else if (vol24 >= 500e3) sc += 11; else if (vol24 >= 250e3) sc += 5;
  if (s.e9overE21) sc += 5;
  if (s.volX >= 1.5) sc += 5;
  // Новое условие в баллы не добавляем: минимальный проходной остаётся 86,
  // и инвариант «86+ ровно тогда, когда пройдены все условия» сохраняется.
  // Штраф за глубокое падение. Размер выбран так, чтобы «нож» опускался
  // примерно на уровень монеты, которой не хватает EMA9 (−25 баллов): обе
  // вне входа, но нож далёк от него на дни, а EMA9 переворачивается за
  // минуты, и ставить нож выше в списке ожидания было бы неправдой.
  if (s.fromHigh14 != null && s.fromHigh14 < -10) sc -= 35;
  // Штрафы за раздутый диапазон и памп перед входом — по замеру они уводят
  // ожидание вниз даже там, где остальные условия выполнены
  if (s.range4Pct != null && s.range4Pct >= 8) sc -= 12;
  if (s.runUp24 != null && s.runUp24 > 15) sc -= 15;

  // Спред критичен: цель всего 1.38%, широкий спред съедает её на входе-выходе
  const wideSpread = spreadKnown && !spreadOk;
  const missingSpread = !spreadKnown;
  if (wideSpread) sc -= 15;

  if (!liquid) sc = Math.min(sc, 39);
  if (wideSpread || missingSpread) sc = Math.min(sc, 44);
  // Потолок для непрошедших: 77+ ⇔ вход, тот же инвариант, что у REV.
  // Считаем от checks.length, а не от числа — условий стало шесть.
  if (!allOk) sc = Math.min(sc, 74);
  sc = Math.max(0, Math.min(100, Math.round(sc)));

  let tag;
  if (!liquid) tag = 'НЕЛИКВИД';
  else if (wideSpread) tag = 'ШИРОКИЙ СПРЕД';
  else if (s.runUp24 != null && s.runUp24 > 15) tag = 'ПОСЛЕ ПАМПА';
  else if (allOk) tag = 'ВХОД';
  else if (passed === checks.length - 1) tag = 'БЛИЗКО';
  else tag = 'ЖДАТЬ';
  if (missingSpread && liquid) tag = '\u0421\u041f\u0420\u0415\u0414 \u041d/\u0414';

  return {
    score: sc, tag, pass: allOk, passed, checks,
    rsi: s.rsi5, rangePos: s.rangePos, volX: s.volX,
    range4Pct: s.range4Pct, dropFromHigh4Pct: s.dropFromHigh4Pct, runUp24: s.runUp24,
    // Отдаём числами: лаборатория раньше выковыривала rsiMin регуляркой из
    // русского текста проверки и молча получала NaN при правке формулировки
    rsiMin: s.rsiMin1h, rsiRecover: !!s.rsiRecover,
    aboveE9: !!s.aboveE9,
    spreadPct: spreadKnown ? Math.round(spreadPct * 100) / 100 : null,
    spreadVerified: spreadKnown,
  };
}

module.exports = { fetchScalpSignals, calcScalpScore, rsiSeries, ema };
