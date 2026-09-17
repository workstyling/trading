// Список пар с биржи — всегда массивом.
//
// При перегрузке или обслуживании биржа отвечает не массивом, а объектом с
// сообщением. Девять мест из десяти звали .filter сразу на ответе, и в
// журнале сервера это выглядело как «[score] tick products.filter is not a
// function». Проход молча пропускался, а отличить сбой биржи от «нечего
// считать» было нельзя: обе ситуации выглядели как тишина.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8').split('\r\n').join('\n');

function load(answer, status = 200) {
  const calls = [];
  const ctx = { console, Array, Error, Number, String,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { status, json: async () => (typeof answer === 'function' ? answer() : answer) };
    } };
  vm.createContext(ctx);
  const i = src.indexOf('async function fetchProducts(');
  const j = src.indexOf('\n}', i) + 2;
  vm.runInContext(src.slice(i, j) + ';this.get = fetchProducts;', ctx);
  ctx.calls = calls;
  return ctx;
}

(async () => {
  console.log('\nОбычный ответ');
  {
    const rows = [{ id: 'BTC-USD', quote_currency: 'USD', status: 'online' }];
    const ctx = load(rows);
    const got = await ctx.get();
    ok(Array.isArray(got) && got.length === 1, 'массив возвращается как есть');
    ok(ctx.calls[0].url === 'https://api.exchange.coinbase.com/products', 'без хвоста — простой список');
    ok(/trading-app/.test(ctx.calls[0].opts.headers['User-Agent']), 'с тем же представлением, что и везде');
    const spot = load(rows);
    await spot.get('?type=SPOT');
    ok(/\?type=SPOT$/.test(spot.calls[0].url), 'хвост запроса передаётся');
    ok((await load([]).get()).length === 0, 'пустой список — это ответ, а не ошибка');
  }

  console.log('\nБиржа ответила не списком');
  {
    const say = async (answer, status) => {
      try { await load(answer, status).get(); return null; } catch (e) { return e.message; }
    };
    const m = await say({ message: 'rate limit exceeded' }, 429);
    ok(m && /не вернула список пар/.test(m), 'ошибка названа своими словами, а не TypeError', m);
    ok(m && /rate limit exceeded/.test(m), 'и сообщение биржи сохранено');
    const noMsg = await say({ foo: 1 }, 503);
    ok(noMsg && /код 503/.test(noMsg), 'без сообщения — хотя бы код ответа', noMsg);
    ok(await say(null, 200), 'пустой ответ тоже ошибка');
    ok(await say('<html>maintenance</html>', 200), 'страница вместо данных тоже');
    // Сломанный JSON не должен падать иначе, чем остальные случаи
    const broken = load(() => { throw new Error('Unexpected token <'); }, 200);
    let msg = null;
    try { await broken.get(); } catch (e) { msg = e.message; }
    ok(msg && /не вернула список пар/.test(msg), 'нечитаемый ответ — та же понятная ошибка', msg);
  }

  console.log('\nВсе места берут список одинаково');
  {
    // Прямой .json() на ответе /products — это возвращённая дыра
    ok(!/await cbRes\.json\(\)/.test(src), 'прямого разбора ответа /products не осталось');
    ok(!/const prodRes = await fetch\(`\$\{CB\}\/products/.test(src), 'и обходных путей тоже');
    const uses = (src.match(/await fetchProducts\(/g) || []).length;
    ok(uses >= 10, 'через общий вход идут все места', 'их ' + uses);
    // Каждый .filter по парам обязан стоять после общего входа
    const filters = src.split('\n').map((l, k) => ({ l, k }))
      .filter(x => /products\.filter\(|products$/.test(x.l) && !x.l.trim().startsWith('//'));
    ok(filters.length > 0, 'места разбора списка на месте');
  }

  console.log(bad ? '\nПЛОХО: ' + bad : '\nвсё зелено');
  process.exit(bad ? 1 : 0);
})();
