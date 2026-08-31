import { coins } from './coins.js';

export async function tokenTimeReal() {
  console.log('tokenTimeReal function started');

  let totalTraffic = 0;

  const intervals = ['7d', '24h', '2h', '1h', '30m', '20m', '10m', '5m'];
  const alerts = {
    '20m': -2,
    '30m': -2,
    '1h': -3,
    '2h': -5,
  };

  let html = `
    <div class="flex items-center gap-2 mb-4">
      <a 
        href="https://coinmarketcap.com/exchanges/coinbase-exchange/" 
        target="_blank"
        class="text-blue-500 hover:text-blue-700 font-bold text-sm"
        style="margin-right: 20px;"
      >
        Coinbase Exchange
      </a>
      <label for="buy-percent-input" class="font-bold">Buy Limit %:</label>
      <input 
        type="number" 
        id="buy-percent-input" 
        value="0.15" 
        step="0.01" 
        class="border p-1 rounded w-20 text-center"
        style="font-size: 12px; height: 24px; font-weight: 700;"
      />
      <div id="traffic-counter" 
        class="ml-4 text-sm font-bold" 
        style="color: #666; display: inline-block; background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">
        Traffic: 0 MB
      </div>
    </div>
  `;

  const container = document.querySelector('.token-time-online');
  if (!container) {
    console.error('Container .token-time-online not found');
    return;
  }
  container.innerHTML = html;

  const worker = new Worker('/worker.js');

  worker.onmessage = (event) => {
    const { type, data } = event.data;
    if (type === 'update') {
      try {
        const messageString = JSON.stringify(event.data);
        const messageSize = new TextEncoder().encode(messageString).length;
        totalTraffic += messageSize;
        
        const trafficCounter = document.getElementById('traffic-counter');
        if (trafficCounter) {
          const trafficMB = (totalTraffic / (1024 * 1024)).toFixed(2);
          console.log('Message size:', messageSize, 'bytes, Total traffic:', trafficMB, 'MB');
          trafficCounter.textContent = `Traffic: ${trafficMB} MB`;
          
          if (totalTraffic > 10 * 1024 * 1024) {
            trafficCounter.style.color = '#ff4136';
          } else if (totalTraffic > 5 * 1024 * 1024) {
            trafficCounter.style.color = '#ff851b';
          }
        }

        updatePercentages(data.coin, data);
      } catch (error) {
        console.error('Error calculating traffic:', error);
      }
    }
  };

  worker.postMessage({
    type: 'start',
    config: {
      coins,
      intervals,
    },
  });

  return () => {
    worker.terminate();
  };
}