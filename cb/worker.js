// Основные переменные
let intervals = ['7d', '24h', '2h', '1h', '30m', '20m', '10m', '5m'];
let activeCoins = [];
let intervalId = null;
let isProcessing = false;
const queue = [];

// Константы для быстрой обработки
const BATCH_SIZE = 30;
const QUEUE_PROCESS_INTERVAL = 2;
const UPDATE_INTERVAL = 500;
const MAX_PARALLEL_REQUESTS = 5;

console.log('Worker initialized with settings:', {
  BATCH_SIZE,
  QUEUE_PROCESS_INTERVAL,
  UPDATE_INTERVAL
});

// Добавляем обработку активной строки
self.onmessage = async (event) => {
  const { type, config } = event.data;
  
  if (type === 'start') {
    activeCoins = config.coins;
    intervals = config.intervals;

    if (intervalId) clearInterval(intervalId);

    // Начальная загрузка всех монет
    activeCoins.forEach(coin => queue.push(coin));
    processQueue();

    // Устанавливаем интервал обновления
    intervalId = setInterval(() => {
      activeCoins.forEach(coin => queue.push(coin));
      processQueue();
    }, 1000);

    // Отправляем сообщение для восстановления активной строки
    self.postMessage({
      type: 'restore_active_row',
      data: localStorage.getItem('activeCoin')
    });
  }
}; 

// В функции processQueue добавим параллельную обработку
async function processQueue() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);
    const chunks = [];
    
    // Разбиваем батч на чанки для параллельной обработки
    for (let i = 0; i < batch.length; i += MAX_PARALLEL_REQUESTS) {
      chunks.push(batch.slice(i, i + MAX_PARALLEL_REQUESTS));
    }

    // Обрабатываем чанки последовательно, но монеты в чанке параллельно
    for (const chunk of chunks) {
      await Promise.all(chunk.map(processCoin));
    }

    if (queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, QUEUE_PROCESS_INTERVAL));
    }
  }
  isProcessing = false;
} 

// В функции processCoin добавим логи
async function processCoin(coin) {
  try {
    // ... существующий код ...

    console.log(`Sending data for ${coin}, size: ${JSON.stringify(data).length} bytes`);
    self.postMessage({
      type: 'update',
      data: data
    });

  } catch (error) {
    console.error(`Error processing ${coin}:`, error);
  }
} 