// История прибыли не должна теряться молча.
//
// Она весила 102 289 байт при пределе тела запроса в 102 400. Очередная
// запись перестала помещаться, сервер отвечал 413 — а страница ответ не
// читала вовсе: на экране «Saved +$23.36» и число в общем итоге, в файле
// ничего. Обнаружилось случайно: запись была видна на десктопе и пропадала на
// телефоне, потому что телефон читает историю с сервера заново.
//
// Это единственное место, где живёт результат закрытой сделки. Восстановить
// его неоткуда.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const read = (p) => fs.readFileSync(p, 'utf8').split('\r\n').join('\n');
const src = read('server.js');
const desk = read('public/index.html');
const mob = read('public/mobile/index.html');

console.log('\nПредел тела запроса');
{
  const m = src.match(/express\.json\(\{ limit: '(\d+)(kb|mb)' \}\)/);
  ok(!!m, 'предел задан явно');
  const bytes = m ? Number(m[1]) * (m[2] === 'mb' ? 1024 * 1024 : 1024) : 0;
  // Восемьсот байт на запись: сотня сделок в год — это годы запаса
  ok(bytes >= 1024 * 1024, 'и его хватает надолго, а не впритык', (bytes / 1024 / 1024).toFixed(1) + ' Мб');
  ok(/102 289 байт/.test(src), 'рядом написано, чем это кончилось в прошлый раз');
}

console.log('\nСервер не пишет поверх истории что попало');
{
  const routes = {};
  let stored = null;
  const ctx = {
    console,
    loadProfitHistory: () => ctx._had,
    saveProfitHistory: (h) => { stored = h; },
    _had: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    app: { post: (p, h) => { routes[p] = h; }, get: () => { } },
  };
  vm.createContext(ctx);
  const i = src.indexOf("app.post('/save-profit-history'");
  const j = src.indexOf('\n});\n', i) + 4;
  vm.runInContext(src.slice(i, j), ctx);

  const call = (body) => {
    let code = 200, out = null;
    const res = { status: (c) => { code = c; return res; }, json: (x) => { out = x; return res; } };
    routes['/save-profit-history']({ body }, res);
    return { code, out };
  };

  stored = null;
  let r = call({ history: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }] });
  ok(r.out && r.out.success && stored && stored.length === 6, 'обычное добавление проходит');
  ok(r.out.count === 6, 'и в ответе сказано, сколько записей легло', String(r.out.count));

  stored = null;
  r = call({ history: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] });
  ok(r.out && r.out.success && stored && stored.length === 4, 'удаление одной записи — тоже законно');

  // Так выглядит страница, отправившая недогруженную историю
  stored = null;
  r = call({ history: [{ id: 1 }] });
  ok(r.code === 409 && !r.out.success, 'а обвал списка отклоняется', 'код ' + r.code);
  ok(stored === null, 'и на диск при этом ничего не пишется');

  stored = null;
  r = call({ history: 'не массив' });
  ok(r.code === 400 && !r.out.success, 'не массив — отказ', 'код ' + r.code);
  ok(stored === null, 'и снова ничего не записано');

  stored = null;
  r = call({});
  ok(r.code === 400 && stored === null, 'пустое тело тоже не стирает историю');
}

console.log('\nДесктоп: неудачу видно');
{
  const f = desk.slice(desk.indexOf('async function saveProfitHistoryToServer'),
    desk.indexOf('async function saveGroupProfit'));
  ok(/!res\.ok \|\| !j\.success/.test(f), 'ответ сервера проверяется');
  ok(/profitHistory = before/.test(f), 'при отказе список возвращается к серверному');
  ok(/showCustomAlert\(/.test(f) && /НЕ сохранена/.test(f), 'и об этом говорится прямо');
  ok(/return true;/.test(f) && /return false;/.test(f), 'вызывающему возвращается, дошло ли');

  const g = desk.slice(desk.indexOf('async function saveGroupProfit'),
    desk.indexOf('async function deleteProfitEntry'));
  ok(/const before = JSON\.parse\(JSON\.stringify\(profitHistory\)\)/.test(g), 'снимок делается ДО правки');
  ok((g.match(/if \(!await saveProfitHistoryToServer\(before\)\) return;/g) || []).length === 2,
    'и на обеих ветках — новая запись и обновление существующей — неудача останавливает');
  // Иначе сделка исчезнет и из истории, и из списка выбранных
  ok(g.indexOf('if (!await saveProfitHistoryToServer(before)) return;') < g.indexOf('saveSelectedOrders()'),
    'ордера снимаются с выбора только после успешной записи');

  const d = desk.slice(desk.indexOf('async function deleteProfitEntry'),
    desk.indexOf('async function deleteProfitEntry') + 3000);
  ok(/const before = JSON\.parse\(JSON\.stringify\(profitHistory\)\)/.test(d), 'удаление тоже со снимком');
  ok(/if \(!await saveProfitHistoryToServer\(before\)\) return;/.test(d),
    'и не говорит «удалена», если не удалилась');
}

console.log('\nМобильная: то же поведение');
{
  const g = mob.slice(mob.indexOf('async function saveGroupProfitM'),
    mob.indexOf('async function saveGroupProfitM') + 4000);
  ok(/if \(!saved\.success\)/.test(g), 'ответ проверяется');
  ok(/profitHistory = historyBeforeSave/.test(g), 'и список возвращается назад');
  ok(/toast\(saved\.error/.test(g), 'и ошибка показывается');
  // Обе вёрстки читают одну историю с сервера: разойтись им нельзя
  ok(/api\('\/get-profit-history'\)/.test(mob) && /fetch\('\/get-profit-history'\)/.test(desk),
    'обе берут историю с сервера, а не из своей памяти');
}

console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
process.exit(bad ? 1 : 0);
