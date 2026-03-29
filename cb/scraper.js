const axios = require('axios');
const WebSocket = require('ws');
const { coins } = require('./public/js/coins.js');
const puppeteer = require('puppeteer');

class CoinbaseDataManager {
    constructor() {
        this.ws = null;
        this.subscriptions = new Map();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.priceCache = new Map(); // Кэш для хранения текущих цен
    }

    connect() {
        try {
            this.ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');

            this.ws.on('open', () => {
                console.log('WebSocket Connected');
                this.reconnectAttempts = 0;
                this.resubscribeAll();
            });

            this.ws.on('close', () => {
                console.log('WebSocket Disconnected');
                this.attemptReconnect();
            });

            this.ws.on('error', (error) => {
                console.error('WebSocket Error:', error);
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    if (message.type === 'l2update' || message.type === 'snapshot') {
                        this.handleL2Update(message);
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            });
        } catch (error) {
            console.error('Error connecting to WebSocket:', error);
            this.attemptReconnect();
        }
    }

    subscribe(productId) {
        try {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.connect();
            }

            const subscription = {
                type: "subscribe",
                product_ids: [productId],
                channels: ["level2"]
            };

            this.ws.send(JSON.stringify(subscription));
            this.subscriptions.set(productId, true);
        } catch (error) {
            console.error(`Error subscribing to ${productId}:`, error);
        }
    }

    handleL2Update(data) {
        try {
            if (data.type === 'snapshot') {
                // Обработка начального снимка данных
                this.priceCache.set(data.product_id, {
                    bestBid: data.bids[0][0],
                    bestAsk: data.asks[0][0]
                });
            } else if (data.type === 'l2update') {
                // Обновление кэша цен
                const currentPrices = this.priceCache.get(data.product_id) || {};
                data.changes.forEach(([side, price]) => {
                    if (side === 'buy') {
                        currentPrices.bestBid = price;
                    } else {
                        currentPrices.bestAsk = price;
                    }
                });
                this.priceCache.set(data.product_id, currentPrices);
            }

            // Отправляем обновления через callback
            if (this.onUpdate) {
                this.onUpdate(data);
            }
        } catch (error) {
            console.error('Error handling L2 update:', error);
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            setTimeout(() => this.connect(), 5000);
        }
    }

    resubscribeAll() {
        for (const [productId] of this.subscriptions) {
            this.subscribe(productId);
        }
    }

    getCurrentPrice(productId) {
        return this.priceCache.get(productId);
    }

    // Добавим метод для массовой подписки
    async subscribeToAll(pairs) {
        try {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.connect();
            }

            // Подписываемся на все пары сразу
            const subscription = {
                type: "subscribe",
                product_ids: pairs,
                channels: ["level2"]
            };

            this.ws.send(JSON.stringify(subscription));
            pairs.forEach(pair => this.subscriptions.set(pair, true));
            
            console.log(`Subscribed to ${pairs.length} pairs`);
        } catch (error) {
            console.error('Error subscribing to pairs:', error);
        }
    }
}

async function getVolumeFromPage(page, pair) {
    try {
        console.log(`[${pair}] Loading page...`);
        
        await page.goto(`https://exchange.coinbase.com/trade/${pair}`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await page.waitForSelector('body', { timeout: 10000 });
        
        const statsResponse = await axios.get(
            `https://api.exchange.coinbase.com/products/${pair}/stats`,
            {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                    'Accept': 'application/json'
                }
            }
        );

        if (statsResponse.data && statsResponse.data.volume) {
            const volume = parseFloat(statsResponse.data.volume);
            console.log(`[${pair}] Found volume: ${volume}`);
            return volume;
        }
        
        console.log(`[${pair}] No volume found in API response`);
        return null;

    } catch (error) {
        console.error(`[${pair}] Error getting volume:`, error.message);
        return null;
    }
}

async function getMonthlyLosers() {
    try {
        console.log('Starting to fetch data...');
        // Берем только активные пары с USD
        const pairs = coins.map(coin => `${coin}-USD`);
        console.log(`Will process ${pairs.length} pairs...`);

        let allLosersData = [];
        let processedCount = 0;

        // Обрабатываем по 5 монет параллельно
        const chunkSize = 5;
        for (let i = 0; i < pairs.length; i += chunkSize) {
            const chunk = pairs.slice(i, i + chunkSize);
            const promises = chunk.map(async (pair) => {
                try {
                    // Получаем базовые данные
                    const [ticker, stats] = await Promise.all([
                        axios.get(`https://api.exchange.coinbase.com/products/${pair}/ticker`),
                        axios.get(`https://api.exchange.coinbase.com/products/${pair}/stats`)
                    ]);

                    if (!ticker.data?.price || !stats.data) {
                        return null;
                    }

                    const currentPrice = parseFloat(ticker.data.price);
                    const volume24h = parseFloat(stats.data.volume || '0');
                    const bestBid = parseFloat(stats.data.best_bid || currentPrice);
                    const bestAsk = parseFloat(stats.data.best_ask || currentPrice);

                    // Получаем исторические данные за 30 дней
                    const endTime = new Date();
                    const startTime = new Date(endTime - 30 * 24 * 60 * 60 * 1000);
                    
                    const candlesResponse = await axios.get(
                        `https://api.exchange.coinbase.com/products/${pair}/candles`,
                        {
                            params: {
                                granularity: 86400,
                                start: startTime.toISOString(),
                                end: endTime.toISOString()
                            }
                        }
                    );

                    if (!candlesResponse.data?.length) {
                        return null;
                    }

                    const oldPrice = parseFloat(candlesResponse.data[candlesResponse.data.length - 1][4]);
                    const percentChange = ((currentPrice - oldPrice) / oldPrice) * 100;

                    processedCount++;
                    console.log(`Processed ${processedCount}/${pairs.length}: ${pair} (${percentChange.toFixed(2)}%)`);

                    if (percentChange <= -30) {
                        return {
                            name: pair.split('-')[0],
                            id: pair,
                            currentPrice: currentPrice.toFixed(8),
                            oldPrice: oldPrice.toFixed(8),
                            percentChange: percentChange.toFixed(2),
                            volume24h: `$${Math.round(volume24h).toLocaleString()}`,
                            bestBid: bestBid.toFixed(8),
                            bestAsk: bestAsk.toFixed(8)
                        };
                    }
                    return null;
                } catch (error) {
                    console.error(`Error processing ${pair}:`, error.message);
                    return null;
                }
            });

            const results = await Promise.all(promises);
            allLosersData = allLosersData.concat(results.filter(r => r !== null));

            // Показываем прогресс
            console.log(`Progress: ${processedCount}/${pairs.length} pairs processed`);
            
            // Небольшая задержка между чанками
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`Processing complete. Found ${allLosersData.length} losers`);
        
        return allLosersData.sort((a, b) => 
            parseFloat(a.percentChange) - parseFloat(b.percentChange)
        );

    } catch (error) {
        console.error('Fatal error in getMonthlyLosers:', error);
        return [];
    }
}

const dataManager = new CoinbaseDataManager();

module.exports = {
    getMonthlyLosers,
    dataManager
}; 