// На торговом экране остаётся одна таблица — «Рейтинг отката». Лаборатории
// со экрана убраны, но не удалены: сервер считает их по-прежнему, весь код
// продолжает писать в скрытые блоки, ничего не падает.
const fs = require('fs');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };

for (const [file, sfx] of [['public/index.html', ''], ['public/mobile/index.html', 'M']]) {
  console.log('\n' + file);
  const src = fs.readFileSync(file, 'utf8');

  // Скрыт ли блок: ищем открывающий тег по id и смотрим его же style
  const hidden = (id) => {
    const i = src.indexOf('id="' + id + '"');
    if (i < 0) return null;
    const tag = src.slice(src.lastIndexOf('<', i), src.indexOf('>', i) + 1);
    return /display:\s*none/.test(tag);
  };

  ok(hidden('microScalpPanel' + sfx) === true, 'быстрый скальп убран с экрана');
  ok(hidden('scalpScanPanel' + sfx) === true, 'скальп по рынку убран с экрана');

  // Полосу открытых сделок мало спрятать: рисовальщик возвращает ей display,
  // поэтому она обязана лежать внутри скрытой обёртки.
  const i = src.indexOf('id="tlPaperStrip' + sfx + '"');
  ok(i > 0, 'полоса paper-сделок на месте в разметке');
  ok(/<div style="display:none;">\s*$/.test(src.slice(Math.max(0, i - 200), src.lastIndexOf('<', i))),
    'и завёрнута в скрытую обёртку');

  ok(hidden('entryScanBox' + sfx) !== true, 'таблица для покупки видна');
  ok(src.indexOf('id="entryScanBox' + sfx + '"') > 0, 'и она в разметке одна',
    String(src.split('id="entryScanBox' + sfx + '"').length - 1) + ' шт.');
  ok(src.split('id="entryScanBox' + sfx + '"').length === 2, 'ровно одна');

  // Ничего не удалено — иначе расчёты в браузере начнут падать на null
  for (const id of ['msBody' + sfx, 'ssBody' + sfx, 'msAgo' + sfx, 'ssAgo' + sfx,
                    'tlPaperBudget' + sfx, 'msRefreshBtn' + sfx, 'ssRefreshBtn' + sfx]) {
    ok(src.includes('id="' + id + '"'), 'цел элемент ' + id);
  }
  // Переключателя сворачивания больше нет: сворачивать нечего
  ok(!src.includes('labFold'), 'кнопок сворачивания не осталось');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
