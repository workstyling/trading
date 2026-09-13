// Совместимый запуск актуальной сверки сетки. Корзина берётся из панели.
// Старый расчёт с баллом 40+ и одномерными вероятностями удалён.
const path = require('path');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const numbers = args.filter(x => !x.startsWith('-'));
const days = numbers.length > 1 ? numbers[1] : (numbers[0] || '25');
const result = spawnSync(process.execPath,
  [path.join(__dirname, 'recheck-recovery.js'), days, ...args.filter(x => x.startsWith('-'))],
  { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status == null ? 1 : result.status;
