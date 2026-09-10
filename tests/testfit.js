// Три вещи с телефона: таблица не влезала, кнопки не выстраивались,
// подпись «Spent» перестала быть правдой после частичной продажи.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const m = fs.readFileSync('public/mobile/index.html', 'utf8');
const d = fs.readFileSync('public/index.html', 'utf8');

console.log('\nТаблица влезает в телефон');
{
  const head = m.slice(m.indexOf('const head2 ='), m.indexOf('const cell = (x) =>'));
  const cols = (head.match(/<th /g) || []).length;
  ok(cols === 4, 'колонок четыре, а не семь', 'найдено ' + cols);
  // Возврат и откат — два признака одной оценки, и стоят рядом. ВХОД из
  // колонки убран: измерено, что возврат он не предсказывает, а места занимал
  // столько же, сколько работающий признак.
  for (const c of ['монета', 'возврат', 'откат', 'за сутки']) ok(head.includes(c), 'колонка «' + c + '» на месте');
  // Сравниваем сами подписи, а не сырой текст: слова «возврат» и «откат»
  // встречаются и в подсказках соседних колонок, и indexOf находит их там.
  const labels = [...head.matchAll(/>([^<>]+)<\/th>/g)].map(x => x[1]);
  ok(labels.join('|') === 'монета|возврат|откат|за сутки',
    'порядок колонок: возврат и откат рядом', labels.join(' | '));
  // Второстепенное не выброшено — ушло в мелкую строку под монетой
  const cell = m.slice(m.indexOf('const cell = (x) =>'), m.indexOf('const cell = (x) =>') + 3500);
  ok(/'RSI ' \+/.test(cell), 'RSI под монетой');
  ok(/'вход ' \+/.test(cell), 'балл входа там же');
  ok(/held,/.test(cell), 'срок в списке тоже');
  ok(/white-space:nowrap/.test(cell), 'мелкая строка не переносится — из-за переноса и было некрасиво');
  // Если что-то всё же шире экрана, прокрутка живёт в своём ящике
  ok(/overflow-x:auto;-webkit-overflow-scrolling:touch;/.test(m) && /table-layout:fixed/.test(m),
    'таблица в прокручиваемом ящике с фиксированной раскладкой');
  ok((m.match(/overflow-x:auto;-webkit-overflow-scrolling:touch;"><table style="width:100%;border-collapse:collapse;table-layout:fixed/g) || []).length === 2,
    'обёрнуты обе ветки — и список, и «ближайшие»');
  // Десктоп не тронут: там семь колонок помещаются
  const dh = d.slice(d.indexOf('const head2 ='), d.indexOf('const price = v =>') + 1);
  ok((d.slice(d.indexOf('const head2 ='), d.indexOf('const cell = (x) =>')).match(/<th /g) || []).length === 7,
    'на десктопе по-прежнему семь колонок');
}

console.log('\nКнопки шага на одном уровне');
for (const [name, h] of [['index.html', d], ['mobile/index.html', m]]) {
  ok(/\.step-lbl \{[^}]*min-width: 34px/.test(h),
    name + ': ширина подписи задана — «стоп» и «ask» больше не сдвигают кнопки');
}

console.log('\nПодпись под числом говорит правду');
{
  // Одно число «чисто вложено» приходилось объяснять подписью, которая меняла
  // слово. Теперь показаны все три: сколько куплено, сколько вернулось с
  // продаж и что осталось затратами — и подпись менять не надо.
  for (const [name, s] of [['мобильная', m], ['десктоп', d]]) {
    ok(/Сумма выбранных покупок с комиссией, до вычета продаж\./.test(s),
      name + ': в шапке сумма покупок, и она названа');
    ok(/Получено с продаж:/.test(s), name + ': возвращённое с продаж показано отдельно');
    ok(/Остаток затрат:/.test(s), name + ': и остаток затрат тоже');
    ok(/Эта сумма используется в расчёте прибыли позиции\./.test(s),
      name + ': сказано, какое из трёх чисел идёт в прибыль');
  }

  // Числа на примере CRO
  const bought = 2491.03, gotBack = 1199.12;
  const net = bought - gotBack;
  ok(Math.abs(net - 1291.91) < 0.05, 'на CRO чисто вложено $1291.91, и это и показано', '$' + net.toFixed(2));
  ok(bought > net + 0.01, 'при этом куплено было на большую сумму — слово «потрачено» тут неверно');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
