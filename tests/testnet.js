// Панель обязана сама говорить, что покупать по ней нельзя.
//
// Частота касания цели читается как обещание прибыли — тем более когда
// строки отсортированы по ней и подсвечены зелёным. Прогон по свечам 86
// монет за 09.08-13.09 говорит обратное: ни один из шестнадцати режимов
// (горизонты 1/4/12/24 ч на целях 0.30/1/2/3%) не окупает издержки, и ни
// один не лучше случайного входа. Цель +0.30% равна круговому обороту
// тейкером — частота сама по себе не обещает ничего.
//
// Молчать об этом значит продавать список наблюдения как список покупки.
const fs = require('fs');
const { renderRecoveryNet } = require('../public/js/recovery-journal');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = p => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');

const net = { at: '2026-09-15', from: '2026-08-09', to: '2026-09-13', horizonH: 1, target: 0.3,
  panel: -0.299, panelSe: 0.012, control: -0.285, controlSe: 0.008,
  n: 10588, controlN: 18523, betterModes: 0, plusModes: 0, modes: 16,
  worst: { horizonH: 24, target: 3, panel: -0.15, control: 0.177, diff: -0.326, se: 0.14 } };
const text = html => html.replace(/<[^>]+>/g, ' ');

console.log('\nСтрока о прибыльности отбора');
{
  const html = renderRecoveryNet({ entryNet: net });
  ok(/Покупать по этому списку нельзя/.test(text(html)), 'сказано прямо, а не намёком');
  ok(/-0\.30%/.test(text(html)) && /-0\.28%/.test(text(html)), 'приведены оба числа: отбор и случайный вход');
  ok(/не окупился\s+ни один/.test(text(html)), 'названо, сколько режимов окупилось');
  ok(/2026-08-09/.test(html) && /2026-09-13/.test(html), 'окно измерения названо');
  ok(/список наблюдения/.test(text(html)), 'сказано, чем список является');
  ok(/measure-net\.js/.test(html), 'в подсказке есть, чем пересчитать');
  ok(/мейкер 0\.075%, тейкер 0\.15%/.test(html), 'и какие комиссии учтены');
  ok(/растущем рынке/.test(html), 'оговорка про период не потеряна');
}

console.log('\nКогда клетка пройдёт порог, строка станет разрешающей');
{
  // Ничего дописывать для этого не нужно: список клеток приходит с сервера,
  // и панель сама меняет и цвет строки, и её текст.
  const allowed = { ...net, buyCells: [{ lo: 10, deep: false, horizonH: 4, target: 2,
    netA: 0.31, seA: 0.1, netB: 0.28, seB: 0.09, n: 900 }] };
  const html = renderRecoveryNet({ entryNet: allowed });
  ok(text(html).includes('Разрешена к покупке 1 клетка'), 'сказано, сколько клеток разрешено');
  ok(!text(html).includes('Покупать по этому списку нельзя'), 'запрет снят, а не оставлен рядом');
  ok(html.includes('rgba(0,255,168'), 'и строка больше не красная');
  ok(text(html).includes('помечены словом «брать»'), 'сказано, где искать разрешённые строки');
  const two = renderRecoveryNet({ entryNet: { ...allowed, buyCells: [allowed.buyCells[0], allowed.buyCells[0]] } });
  ok(text(two).includes('Разрешены к покупке 2 клетки'), 'число согласовано со словом');
}

console.log('\nБез измерения строка молчит');
{
  ok(renderRecoveryNet({}) === '', 'нет данных — нет утверждения');
  ok(renderRecoveryNet({ entryNet: null }) === '', 'пустое поле не ломает панель');
  ok(renderRecoveryNet({ entryNet: { ...net, panel: null } }) === '', 'без числа отбора строки нет');
  ok(renderRecoveryNet({ entryNet: { ...net, control: 'нет' } }) === '', 'без контроля строки нет');
  ok(renderRecoveryNet({ entryNet: { ...net, modes: 0 } }) === '', 'без режимов строки нет');
  ok(renderRecoveryNet({ entryNet: { ...net, worst: null } }) !== '', 'но без худшего режима строка остаётся');
}

console.log('\nКогда отбор начнёт окупаться, текст изменится сам');
{
  const good = renderRecoveryNet({ entryNet: { ...net, plusModes: 3, panel: 0.42 } });
  ok(/окупились 3/.test(text(good)), 'число окупившихся режимов берётся из измерения');
  ok(/\+0\.42%/.test(text(good)), 'и знак числа тоже');
}

console.log('\nОбе вёрстки и сервер');
for (const [name, file] of [['десктоп', 'public/index.html'], ['мобильная', 'public/mobile/index.html']]) {
  const src = read(file);
  ok(/renderRecoveryNet\(j\) \+ renderRecoveryLegend\(j\)/.test(src), name + ': строка стоит выше таблицы');
  // Числа приходят с сервера: вписать их в вёрстку значит однажды разойтись
  ok(!/-0\.299/.test(src), name + ': числа не вписаны в разметку');
}
{
  const src = read('server.js');
  ok(/const ENTRY_NET = \{/.test(src), 'измерение лежит в коде рядом с остальными');
  ok(/entryNet: ENTRY_NET/.test(src), 'и уходит в панель');
  ok(/plusModes: 0/.test(src), 'записано, сколько режимов окупилось');
  ok(fs.existsSync('scripts/measure-net.js'), 'скрипт пересчёта в репозитории');
  const script = read('scripts/measure-net.js');
  ok(/MAKER = 0\.075, TAKER = 0\.15/.test(script), 'скрипт считает с боевыми комиссиями');
  ok(script.includes('measure(byCoin, () => true, key)'), 'и всегда считает контрольную группу');
  // Разрешение на покупку обязано требовать повтора на второй половине: в
  // прошлый раз четыре признака обогнали базу на августе и развернулись.
  ok(script.includes('A.m - 2 * A.se > 0 && B.m - 2 * B.se > 0'),
    'разрешение требует плюса на обеих половинах с запасом в две ошибки');
  ok(script.includes('buyCells'), 'и уходит в вывод для server.js');
  ok(src.includes('buyCells: []'), 'сейчас разрешённых клеток нет');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
