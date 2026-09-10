// Одна таблица на виду, лаборатории спрятаны, но продолжают считать.
//
// Раньше их сворачивали кнопкой; теперь панели убраны с глаз совсем — просили
// «пусть идут в фоне, мне они не нужны». Удалять их нельзя: на них держится
// форвардный журнал, которым проверяется само правило входа.
//
// Обе вёрстки — однажды они разошлись, и телефон звал покупать то, что
// десктоп запрещал.
const fs = require('fs');

let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };

// Вырезать содержимое элемента с этим id вместе с его style
const openTag = (src, id) => {
  const i = src.indexOf('id="' + id + '"');
  if (i < 0) return null;
  const a = src.lastIndexOf('<', i);
  return src.slice(a, src.indexOf('>', i) + 1);
};

for (const [file, sfx] of [['public/index.html', ''], ['public/mobile/index.html', 'M']]) {
  console.log('\n' + file);
  const src = fs.readFileSync(file, 'utf8');

  // Порядок на странице: таблица для покупки должна стоять ВЫШЕ стенда,
  // иначе консолидация ничего не решает — глаз всё равно упрётся в лабораторию.
  const iBox = src.indexOf('id="entryScanBox' + sfx + '"');
  const iLab = src.indexOf('⚡ Быстрый скальп');
  ok(iBox > 0, 'таблица для покупки на месте');
  ok(iBox < iLab, 'и стоит выше лаборатории');
  ok(src.indexOf('id="entryScanBox' + sfx + '"', iBox + 1) < 0, 'ровно одна такая таблица');

  // Панели спрятаны прямо в разметке: без переключателя, без localStorage,
  // без состояния, которое может разъехаться между вёрстками.
  const panel = openTag(src, 'microScalpPanel' + sfx);
  ok(panel && /display:\s*none/.test(panel), 'быстрый скальп скрыт', panel);
  const strip = openTag(src, 'tlPaperStrip' + sfx);
  ok(strip && /display:\s*none/.test(strip), 'полоска paper-сделок тоже скрыта', strip);

  // Ничего не удалено: расчёты идут дальше, журнал копится.
  ok(src.includes('id="ssBody' + sfx + '"'), 'тело скальпа по рынку на месте — оно продолжает считать');
  ok(src.includes('id="msBody' + sfx + '"'), 'тело быстрого скальпа тоже');
  ok(new RegExp("getElementById\\('msBody" + sfx + "'\\)").test(src), 'и в него по-прежнему пишут');
  ok(new RegExp("getElementById\\('ssBody" + sfx + "'\\)").test(src), 'и во второе тоже');

  // Переключателя больше нет — если он вернётся, это разъезд с другой вёрсткой
  ok(!/function labFold/.test(src), 'переключателя сворачивания не осталось');
  ok(!/fold_/.test(src), 'и сохранённого состояния сворачивания тоже');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
