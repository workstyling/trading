// Стоп-лимит на продажу: проверяем то, что может стоить денег.
//
// Главное здесь не разметка, а два условия исполнения: направление стопа
// (вниз, а не вверх) и лимит не выше стопа. Ошибка в любом из них даёт ордер,
// который либо сработает не там, либо не сработает вовсе.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');

console.log('\nСервер: условия исполнения');
{
  const from = src.indexOf("app.post('/create-sell-order'");
  const body = src.slice(from, src.indexOf("app.post('/cancel-order'", from));
  ok(/stop_direction: 'STOP_DIRECTION_STOP_DOWN'/.test(body),
    'продажа срабатывает на движении ВНИЗ, а не вверх');
  ok(!/STOP_DIRECTION_STOP_UP/.test(body), 'обратного направления в продаже нет');
  ok(/if \(limitPrice > stopVal\)/.test(body),
    'лимит выше стопа отклоняется — иначе ордер не исполнится');
  ok(/isPositiveFiniteNumber\(stopVal\)/.test(body), 'стоп-цена проверяется на число');
  ok(/stop_limit_stop_limit_gtc/.test(body), 'ордер собирается как стоп-лимит');
  ok(/delete orderData\.order_configuration\.limit_limit_gtc/.test(body),
    'обычная лимитка при этом убирается, а не остаётся рядом');
  ok(/base_size: sellSize\.toFixed\(baseDecimals\)/.test(body), 'объём округляется по шагу монеты');
  ok(/stop_price: stopVal\.toFixed\(quoteDecimals\)/.test(body), 'стоп округляется по шагу цены');
}

console.log('\nЦены из стакана считаются как заявлено');
{
  // Воспроизводим расчёт окна: стоп на N-м уровне ниже лучшего bid, лимит
  // ещё на gap уровней ниже. Стакан заведомо неровный — уровни не равны шагу.
  const bids = [10, 9.9, 9.8, 9.5, 9.0, 8.2].map(p => ({ p }));
  const calc = (lvl, gap) => {
    const iStop = Math.min(lvl, bids.length - 1);
    const iLim = Math.min(lvl + gap, bids.length - 1);
    return { stop: bids[iStop].p, lim: bids[iLim].p, short: lvl > bids.length - 1 || lvl + gap > bids.length - 1 };
  };
  let r = calc(3, 2);
  ok(r.stop === 9.5 && r.lim === 8.2, 'уровень 3 и отступ 2 дают стоп 9.5 и лимит 8.2', JSON.stringify(r));
  ok(r.lim <= r.stop, 'лимит не выше стопа — условие исполнения соблюдено');
  r = calc(1, 0);
  ok(r.stop === 9.9 && r.lim === 9.9, 'нулевой отступ ставит лимит на стоп');
  // Стакан короче запроса: берём последний уровень и ГОВОРИМ об этом.
  r = calc(20, 5);
  ok(r.stop === 8.2 && r.short === true, 'запрос глубже стакана помечается, а не подставляется молча');
}

console.log('\nДесктоп: одна кнопка, работающая по числам из строки');
{
  const h = fs.readFileSync('public/index.html', 'utf8');
  // Кнопок стоп-лимита было две: верхняя открывала окно, нижняя ставила по
  // настройкам из строки. Числа теперь видны прямо в строке, окно лишнее.
  const n = (h.match(/Sell Stop|SELL STOP/g) || []).length;
  ok(n === 1, 'кнопка стоп-лимита ровно одна', 'найдено ' + n);
  ok(!/sellAllStopLimit\b/.test(h), 'окно удалено, а не оставлено мёртвым кодом');
  ok(/onclick="sellStopInline\(/.test(h), 'кнопка ставит ордер по числам из строки');
  ok(/orderType: 'stop_limit'/.test(h), 'ордер уходит как стоп-лимит');
  ok(/stopPrice: st\.stop/.test(h) && /price: st\.limit/.test(h), 'стоп и лимит уходят разными полями');
  ok(/if \(st\.stop < st\.limit\)/.test(h), 'стоп ниже лимита отклоняется до отправки');
  ok(/не гарантирует исполнения/.test(h), 'сказано, что исполнение не гарантировано');
}

console.log('\nМобильная: тот же путь, что на десктопе');
{
  // Окно заменено строкой настроек в обеих вёрстках — подробности разметки
  // и узкого экрана проверяет testmob.js, здесь только общие для ордера
  // условия, чтобы они не разошлись между вёрстками.
  const h = fs.readFileSync('public/mobile/index.html', 'utf8');
  ok(!/sellAllStopLimitM/.test(h), 'окна не осталось');
  ok(/onclick="sellStopInlineM\(/.test(h), 'ордер ставится по числам из строки');
  ok(/orderType: 'stop_limit'/.test(h), 'ордер уходит как стоп-лимит');
  ok(/stopPrice: st\.stop/.test(h) && /price: st\.limit/.test(h), 'стоп и лимит уходят разными полями');
  ok(/if \(st\.stop < st\.limit\)/.test(h), 'стоп ниже лимита отклоняется до отправки');
  ok(/не гарантирует исполнения/.test(h), 'сказано, что исполнение не гарантировано');
  ok(/в стакане всего/.test(h), 'нехватка уровней названа');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
