// Крестик у записи в истории прибыли стирал её СРАЗУ, без вопроса. Вернуть
// неоткуда: это единственное место, где живёт результат закрытой сделки —
// на бирже остаётся сама сделка, а её итог здесь и больше нигде.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const d = fs.readFileSync('public/index.html', 'utf8');
const m = fs.readFileSync('public/mobile/index.html', 'utf8');

console.log('\nМешочек убран');
{
  // Метка «отправлено на счёт» заводилась, показывалась и больше нигде не
  // читалась — ни на сервере, ни в отчётах.
  ok(!/toggleSentToAccount/.test(d), 'десктоп: переключателя нет');
  ok(!/sentToAccount/.test(d), 'десктоп: поле больше не пишется');
  ok(!/sentToAccount/.test(m), 'мобильная: тоже');
  const row = d.slice(d.indexOf('const profitClass = e.profit >= 0'), d.indexOf('listEl.innerHTML = h;'));
  ok(!/💰/.test(row), 'иконки в строке записи не осталось');
  ok(/profit-item-delete/.test(row), 'а крестик удаления на месте');
}

console.log('\nУдаление спрашивает');
{
  const body = d.slice(d.indexOf('async function deleteProfitEntry'), d.indexOf('// Telegram integration'));
  ok(/showConfirmModal\(/.test(body), 'своё окно, а не мгновенное удаление');
  ok(!/\bconfirm\(/.test(body), 'и не системное окно браузера');
  // Удаление обязано быть ВНУТРИ подтверждения, а не рядом с ним
  ok(body.indexOf('showConfirmModal') < body.indexOf('profitHistory = profitHistory.filter'),
    'фильтрация идёт после согласия, а не до него');
  ok(/Вернуть её нельзя/.test(body), 'сказано, что отменить нельзя');
  ok(/пропадёт из истории прибыли и из общего итога/.test(body), 'сказано, что именно пропадёт');
}

console.log('\nВ окне видно, что удаляешь');
{
  const ctx = { Math, console };
  vm.createContext(ctx);
  // Воспроизводим сборку текста
  const mk = (e) => {
    const sum = (e.profit >= 0 ? '+' : '−') + '$' + Math.abs(e.profit).toFixed(2);
    return { sum, coin: e.coin || '—' };
  };
  ok(mk({ coin: 'AVNT', profit: 18.74 }).sum === '+$18.74', 'прибыль со знаком плюс');
  ok(mk({ coin: 'AVNT', profit: -12.5 }).sum === '−$12.50', 'убыток со знаком минус');
  ok(mk({ profit: 0 }).coin === '—', 'без монеты не падает');
  const body = d.slice(d.indexOf('async function deleteProfitEntry'), d.indexOf('// Telegram integration'));
  ok(/e\.coin \|\| '—'/.test(body), 'монета названа в окне');
  ok(/var\(--green\)' : '#ff6b6b'/.test(body), 'прибыль зелёная, убыток красный');
  ok(/e\.sellDate \|\| e\.date/.test(body), 'и дата, если есть');
  // Записи может не оказаться — например, список успел обновиться
  ok(/if \(!e\) return;/.test(body), 'исчезнувшая запись не роняет окно');
}

console.log('\nПосле удаления видно, что произошло');
{
  const body = d.slice(d.indexOf('async function deleteProfitEntry'), d.indexOf('// Telegram integration'));
  ok(/showCustomAlert\('Запись удалена/.test(body), 'сказано, что удалено');
  // Со снимком и с проверкой: не сохранилось — не говорим «удалена»
  ok(/if \(!await saveProfitHistoryToServer\(before\)\) return;/.test(body),
    'изменение сохраняется на сервер, и неудача останавливает');
  ok(/updateProfitPanel\(\)/.test(body), 'панель перерисовывается');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
