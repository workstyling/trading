// Проверяем _flashValue без браузера: подделываем элемент и таймеры.
const fs = require('fs'), vm = require('vm');
const [, , file, sfx = ''] = process.argv;
const src = fs.readFileSync(file, 'utf8');
const i = src.indexOf('function _flashValue' + sfx + '(');
let d = 0, end;
for (let k = src.indexOf('{', i); k < src.length; k++) {
  if (src[k] === '{') d++;
  else if (src[k] === '}') { d--; if (!d) { end = k + 1; break; } }
}
const timers = [];
const ctx = {
  console,
  setTimeout: (fn, ms) => { const id = timers.length; timers.push({ fn, ms, id }); return id; },
  clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.cleared = true; },
};
vm.createContext(ctx);
vm.runInContext(src.slice(i, end), ctx);
const F = ctx['_flashValue' + sfx];
const el = () => ({ textContent: '', style: {} });

let bad = 0;
const check = (name, cond, detail) => { if (!cond) bad++; console.log('  ' + (cond ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : '')); };

// 1. Первая отрисовка не подсвечивает
let e = el(); e.textContent = '—';
F(e, '$277,179');
check('первая отрисовка без подсветки', !e.style.color, 'color=' + (e.style.color || 'нет'));
check('текст выставлен', e.textContent === '$277,179');

// 2. Изменение подсвечивает
F(e, '$278,000');
check('изменение подсвечено', e.style.color === '#4ade80');
check('новый текст на месте', e.textContent === '$278,000');

// 3. Тот же текст — ничего не делает
e.style.color = '';
F(e, '$278,000');
check('повтор того же значения не мигает', !e.style.color);

// 4. Гашение возвращает цвет темы
const before = timers.filter(t => !t.cleared).length;
F(e, '$279,000');
const t = timers[timers.length - 1];
t.fn();
check('после таймера цвет сброшен', e.style.color === '' && e.style.textShadow === '');
check('переход плавный', /color .55s/.test(e.style.transition || ''));

// 5. Две смены подряд — прошлый таймер отменён
let e2 = el(); e2.textContent = '$1';
F(e2, '$2');
const firstId = e2._flashTimer;
F(e2, '$3');
check('прошлый таймер отменён', timers.find(x => x.id === firstId).cleared === true);

// 6. Пустой элемент не роняет
try { F(null, '$5'); check('null не роняет', true); } catch (err) { check('null не роняет', false, err.message); }

console.log(bad ? '\nПРОБЛЕМ: ' + bad : '\nвсе проверки прошли');
