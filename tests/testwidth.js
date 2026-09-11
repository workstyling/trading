// Поля ввода во флекс-строках не должны распирать экран.
//
// Поиск в списке ордеров уезжал за правый край на телефоне. Причина не в
// вёрстке строки, а в умолчании флексбокса: у элемента флекса min-width равен
// auto, а у <input> своя минимальная ширина — около двадцати символов. То
// есть flex:1 растянуть поле может, а сжать ниже этой ширины — нет. Три
// кнопки плюс такое поле в ширину телефона не помещались.
//
// Лечится одной строкой (min-width:0), но забывается регулярно, поэтому
// проверяется здесь: КАЖДОЕ поле ввода в мобильной вёрстке, которому задан
// flex, обязано уметь сжиматься. Классы полей берутся из самой разметки, а не
// из списка в тесте, — иначе новое поле пройдёт мимо проверки.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('public/mobile/index.html', 'utf8').split('\r\n').join('\n');

// Всё, что объявлено для селектора: один и тот же селектор встречается
// несколько раз (базовые стили и поздняя перекраска), и правила складываются.
const rules = (sel) => {
  const out = [];
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const m of src.matchAll(new RegExp('(^|[,\\s])' + esc + '\\s*\\{([^}]*)\\}', 'g'))) out.push(m[2]);
  return out.join('\n');
};

console.log('\nПоиск в ордерах');
{
  const r = rules('.order-search');
  ok(!!r, 'правило найдено');
  ok(/min-width:\s*0/.test(r), 'поле умеет сжиматься');
  ok(/flex:\s*1 1 0/.test(r), 'и занимает ровно остаток строки');

  const row = rules('.orders-filter');
  ok(/display:\s*flex/.test(row), 'строка фильтров — флекс');
  ok(/max-width:\s*100%/.test(row), 'и не шире экрана');
  ok(/box-sizing:\s*border-box/.test(row), 'с отступами внутрь');

  const btn = rules('.filter-btn');
  ok(/flex:\s*0 0 auto/.test(btn), 'кнопки держат свой размер');
  ok(/white-space:\s*nowrap/.test(btn), 'и не переносят подписи при сжатии');
}

console.log('\nВсе поля ввода из разметки — умеют ли сжиматься');
{
  // Классы, которые реально висят на <input> в этой странице
  const classes = new Set();
  for (const m of src.matchAll(/<input\b[^>]*class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) classes.add('.' + c);
  }
  ok(classes.size > 0, 'классы полей ввода найдены в разметке', [...classes].join(' '));

  const broken = [];
  for (const c of classes) {
    const r = rules(c);
    if (!/flex:\s*1/.test(r)) continue;          // не тянется — и не сожмётся лишнего
    if (/min-width:\s*0/.test(r)) continue;      // сжиматься умеет
    broken.push(c);
  }
  ok(broken.length === 0, 'растягивающиеся поля умеют и сжиматься', broken.join(', ') || '');

  // И то же для полей, которым flex задан прямо в разметке
  const inlineBroken = [];
  for (const m of src.matchAll(/<input\b[^>]*style="([^"]*)"[^>]*>/g)) {
    if (!/flex:\s*1/.test(m[1])) continue;
    if (/min-width/.test(m[1])) continue;
    // Класс может дотянуть min-width за него
    const cls = (m[0].match(/class="([^"]+)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
    if (cls.some(c => /min-width:\s*0/.test(rules('.' + c)))) continue;
    inlineBroken.push((cls[0] || '?') + ' (flex в разметке)');
  }
  ok(inlineBroken.length === 0, 'и те, которым flex задан прямо в строке', inlineBroken.join(', ') || '');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
