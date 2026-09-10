// Автоматика при исполнении: избранное и сторож безубытка.
const fs = require('fs'), vm = require('vm');
let bad = 0;
const ok = (c, m, x) => { if (!c) bad++; console.log('  ' + (c ? 'ok  ' : 'ПЛОХО') + '  ' + m + (x ? '   ' + x : '')); };
const src = fs.readFileSync('server.js', 'utf8');

const files = {};
const ctx = {
  console: { log: () => { }, error: () => { } },
  fs: { existsSync: p => p in files, readFileSync: p => files[p], writeFileSync: (p, v) => { files[p] = v; } },
  favoritesFile: 'fav.json',
  beWatches: [],
  saveBeWatches: () => { },
  loadSettings: () => ctx._settings,
  _settings: { telegramToken: 't', telegramChat: 'c' },
};
vm.createContext(ctx);
// beOptOutSet появился вместе со сверкой состояния: постановка сторожа
// снимает отказ, иначе сверка не вернула бы его после новой покупки.
ctx.beOptOut = [];
ctx.saveBeOptOut = () => { };
ctx.beOptOutSet = (coin, off) => {
  const had = ctx.beOptOut.includes(coin);
  if (off && !had) ctx.beOptOut.push(coin);
  else if (!off && had) ctx.beOptOut = ctx.beOptOut.filter(c => c !== coin);
};
for (const fn of ['positionFromOrders', 'autoFavorite', 'autoBeWatch'])
  vm.runInContext(src.match(new RegExp('function ' + fn + '[\\s\\S]*?\\n}'))[0], ctx);

const o = (side, size, val, status) => ({ product_id: 'AAA-USD', side, filled_size: String(size), total_value: String(val), status: status || 'FILLED' });

console.log('\nПозиция считается по исполненным ордерам');
ok(JSON.stringify(ctx.positionFromOrders([o('BUY', 10, 100)], 'AAA-USD')) === '{"filled":10,"usd":100}', 'одна покупка');
ok(JSON.stringify(ctx.positionFromOrders([o('BUY', 10, 100), o('BUY', 5, 60)], 'AAA-USD')) === '{"filled":15,"usd":160}', 'докупка складывается');
ok(JSON.stringify(ctx.positionFromOrders([o('BUY', 10, 100), o('SELL', 4, 50)], 'AAA-USD')) === '{"filled":6,"usd":50}', 'продажа вычитается');
// Неисполненная лимитка не должна попадать в позицию: именно поэтому сторож
// и ставится по факту исполнения, а не при выставлении ордера.
ok(JSON.stringify(ctx.positionFromOrders([o('BUY', 10, 100), o('BUY', 0, 0, 'OPEN')], 'AAA-USD')) === '{"filled":10,"usd":100}', 'открытая лимитка не считается');
ok(JSON.stringify(ctx.positionFromOrders([o('BUY', 10, 100), { product_id: 'BBB-USD', side: 'BUY', filled_size: '9', total_value: '90', status: 'FILLED' }], 'AAA-USD')) === '{"filled":10,"usd":100}', 'чужая монета не считается');

console.log('\nИзбранное');
ctx.autoFavorite('AAA');
ok(files['fav.json'] === '["AAA"]', 'монета добавлена', files['fav.json']);
ctx.autoFavorite('AAA');
ok(files['fav.json'] === '["AAA"]', 'повторно не дублируется');
ctx.autoFavorite('BBB');
ok(JSON.parse(files['fav.json']).length === 2, 'вторая монета добавляется, первая цела');

console.log('\nСторож безубытка');
ctx.beWatches = [];
ctx.autoBeWatch('AAA', 'AAA-USD', [o('BUY', 10, 100)]);
ok(ctx.beWatches.length === 1 && ctx.beWatches[0].filled === 10 && ctx.beWatches[0].usd === 100,
  'ставится с объёмом и потраченным', JSON.stringify(ctx.beWatches[0]));
ok(ctx.beWatches[0].auto === true, 'помечен как поставленный автоматически');

// Докупка обязана пересчитать сторож: старый считал бы безубыток по прежней
// позиции и сработал бы не там.
ctx.autoBeWatch('AAA', 'AAA-USD', [o('BUY', 10, 100), o('BUY', 10, 140)]);
ok(ctx.beWatches.length === 1 && ctx.beWatches[0].usd === 240, 'докупка пересчитывает, а не дублирует', JSON.stringify(ctx.beWatches[0]));

ctx.autoBeWatch('AAA', 'AAA-USD', [o('BUY', 10, 100), o('SELL', 10, 120)]);
ok(ctx.beWatches.length === 0, 'после полного выхода сторож снят');

ctx.beWatches = [];
ctx._settings = {};
ctx.autoBeWatch('AAA', 'AAA-USD', [o('BUY', 10, 100)]);
ok(ctx.beWatches.length === 0, 'без настроенного Telegram сторож не ставится');
ctx._settings = { telegramToken: 't', telegramChat: 'c' };

console.log('\nКлиент: избранное сразу при выставлении');
for (const p of ['public/index.html', 'public/mobile/index.html']) {
  const h = fs.readFileSync(p, 'utf8');
  const n = (h.match(/favoriteAfterOrder\(/g) || []).length;
  ok(/async function favoriteAfterOrder/.test(h), p.replace('public/', '') + ': помощник есть');
  ok(n >= 3, p.replace('public/', '') + ': вызван из всех веток покупки', 'вызовов ' + (n - 1));
  ok(!/favoriteAfterOrder[\s\S]{0,200}be-watch/.test(h), p.replace('public/', '') + ': BE тут не ставится');
}

console.log(bad ? '\n' + bad + ' проверок не прошло' : '\nвсе проверки прошли');
process.exit(bad ? 1 : 0);
