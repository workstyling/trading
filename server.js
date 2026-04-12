require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { RESTClient } = require('./cb/dist/rest/index.js');

// Prevent server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[CRASH PREVENTED] Uncaught Exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH PREVENTED] Unhandled Rejection:', reason);
});

// Graceful shutdown
let server;
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  if (server) {
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
    // Force exit after 5 seconds if server doesn't close
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

const PORT = process.env.PORT || 3847;
const publicDir = path.join(__dirname, 'public');
const settingsFile = path.join(__dirname, 'settings.json');
const profitFile = path.join(__dirname, 'profit-history.json');

// CryptoRank API
const CRYPTORANK_API_KEY = 'ef01b6459dbfbf7bad96be0c01fbdb393fd5d2bb9c3db186a2bc94d40371';
const CRYPTORANK_BASE_URL = 'https://api.cryptorank.io/v2';

// Default settings
const defaultSettings = {
  sellMarkup: 1.38,    // % увеличения продажи
  tradeFee: 0.06,     // % комиссии limit ордера
  marketFee: 0.125    // % комиссии market ордера
};

// Load/Save settings
function loadSettings() {
  try {
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading settings:', e);
  }
  return defaultSettings;
}

function saveSettings(settings) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// Load/Save profit history
function loadProfitHistory() {
  try {
    if (fs.existsSync(profitFile)) {
      return JSON.parse(fs.readFileSync(profitFile, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading profit history:', e);
  }
  return [];
}

function saveProfitHistory(history) {
  fs.writeFileSync(profitFile, JSON.stringify(history, null, 2));
}

const app = express();

// Coinbase API
const API_KEY = process.env.CB_API_KEY;
const API_SECRET = process.env.CB_API_SECRET;
const client = new RESTClient(API_KEY, API_SECRET);

// CORS для API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.use(express.static(publicDir, { etag: false, lastModified: false }));
app.use(express.json());

// API: Get settings
app.get('/get-settings', (req, res) => {
  const settings = loadSettings();
  res.json({ success: true, settings });
});

// API: Save settings
app.post('/save-settings', (req, res) => {
  try {
    const { sellMarkup, tradeFee, marketFee } = req.body;
    const settings = {
      sellMarkup: parseFloat(sellMarkup) || defaultSettings.sellMarkup,
      tradeFee: parseFloat(tradeFee) || defaultSettings.tradeFee,
      marketFee: parseFloat(marketFee) || defaultSettings.marketFee
    };
    saveSettings(settings);
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Selected orders (shared across devices)
const selectedOrdersFile = path.join(__dirname, 'selected-orders.json');
function loadSelectedOrders() {
  try {
    if (fs.existsSync(selectedOrdersFile)) return JSON.parse(fs.readFileSync(selectedOrdersFile, 'utf8'));
  } catch {}
  return { selected: [], muted: [] };
}
function saveSelectedOrders(data) {
  fs.writeFileSync(selectedOrdersFile, JSON.stringify(data, null, 2));
}

app.get('/get-selected-orders', (req, res) => {
  res.json({ success: true, ...loadSelectedOrders() });
});

app.post('/save-selected-orders', (req, res) => {
  try {
    const { selected, muted } = req.body;
    saveSelectedOrders({ selected: selected || [], muted: muted || [] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Get profit history
app.get('/get-profit-history', (req, res) => {
  const history = loadProfitHistory();
  res.json({ success: true, history });
});

// API: Save profit history
app.post('/save-profit-history', (req, res) => {
  try {
    const { history } = req.body;
    saveProfitHistory(history);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create limit sell order
app.post('/create-sell-order', async (req, res) => {
  try {
    const { productId, size, price } = req.body;
    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'SELL',
      order_configuration: {
        limit_limit_gtc: {
          base_size: size.toString(),
          limit_price: price.toString(),
          post_only: false
        }
      }
    };

    // Fetch product info to get correct precision
    let quoteDecimals = 2, baseDecimals = 8;
    try {
      const prodRes = await fetch(`https://api.exchange.coinbase.com/products/${productId}`);
      if (prodRes.ok) {
        const prod = await prodRes.json();
        if (prod.quote_increment) {
          const inc = prod.quote_increment;
          quoteDecimals = inc.includes('.') ? (inc.split('.')[1].replace(/0+$/, '').length || 0) : 0;
        }
        if (prod.base_increment) {
          const inc = prod.base_increment;
          baseDecimals = inc.includes('.') ? (inc.split('.')[1].replace(/0+$/, '').length || 0) : 0;
        }
      }
    } catch (e) {
      console.warn('Could not fetch product info for sell:', e.message);
    }

    // Fix precision
    orderData.order_configuration.limit_limit_gtc.limit_price = parseFloat(price).toFixed(quoteDecimals);
    orderData.order_configuration.limit_limit_gtc.base_size = parseFloat(size).toFixed(baseDecimals);

    console.log('Creating sell order:', orderData);
    const response = await client.createOrder(orderData);

    if (!response || response.error) {
      throw new Error(response?.error || 'Failed to create order');
    }

    console.log('Sell order response:', JSON.stringify(response, null, 2));
    // Parse response if it's a string
    const parsed = typeof response === 'string' ? JSON.parse(response) : response;

    // Check for Coinbase error response
    if (parsed.success === false || parsed.error_response) {
      const errorMsg = parsed.error_response?.message || parsed.error_response?.error || parsed.error_response?.preview_failure_reason || 'Order rejected';
      console.error('Coinbase rejected sell order:', errorMsg);
      return res.json({ success: false, error: errorMsg, details: parsed });
    }

    const orderId = parsed.success_response?.order_id || parsed.order_id;
    if (!orderId) {
      console.error('No order ID in sell response:', parsed);
      return res.json({ success: false, error: 'No order ID returned', details: parsed });
    }

    console.log('Sell order created, ID:', orderId);
    ordersCache.ts = 0; // invalidate cache
    balanceCache.ts = 0;
    res.json({ success: true, order: parsed, order_id: orderId });
  } catch (error) {
    console.error('Error creating sell order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Cancel order
app.post('/cancel-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    console.log('Cancelling order:', orderId);
    const response = await client.cancelOrders({ order_ids: [orderId] });
    console.log('Cancel response:', response);
    ordersCache.ts = 0; // invalidate cache
    balanceCache.ts = 0;
    res.json({ success: true, response });
  } catch (error) {
    console.error('Error cancelling order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get USD balance
const USD_ACCOUNT_UUID = 'd5990d03-0efb-5421-968a-ed319df31c61';

// Persistent price cache — survives between /get-holdings requests.
// Prevents coins from disappearing when the ticker API temporarily fails.
const priceCache = new Map(); // currency -> price

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getPrice(currency) {
  if (currency === 'USD' || currency === 'USDC') return 1;

  // Source 1: Coinbase Exchange (most accurate, real-time)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(400 * attempt);
      const r = await fetch(`https://api.exchange.coinbase.com/products/${currency}-USD/ticker`);
      if (r.status === 429) continue;
      if (r.ok) {
        const t = await r.json();
        const p = parseFloat(t.price || t.bid || 0);
        if (p > 0) { priceCache.set(currency, p); return p; }
      }
    } catch { }
  }

  // Source 2: Coinbase public v2 API (broader coverage)
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${currency}-USD/spot`);
    if (r.ok) {
      const t = await r.json();
      const p = parseFloat(t.data?.amount || 0);
      if (p > 0) { priceCache.set(currency, p); return p; }
    }
  } catch { }

  // Fallback: last known price — prevents coin from disappearing on temporary failure
  const cached = priceCache.get(currency);
  if (cached) {
    console.warn(`[holdings] price fetch failed for ${currency}, using cached $${cached}`);
    return cached;
  }

  console.warn(`[holdings] no price available for ${currency} — will be filtered out`);
  return 0;
}

// Fast balances endpoint (no price lookups, cached)
let balancesCache = { data: null, ts: 0 };
const BALANCES_CACHE_TTL = 15000; // 15 seconds

async function fetchAccountBalances() {
  const accounts = [];
  let cursor = undefined;
  do {
    const params = { limit: 250 };
    if (cursor) params.cursor = cursor;
    const result = await client.listAccounts(params);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    accounts.push(...(data.accounts || []));
    cursor = data.has_next ? data.cursor : null;
  } while (cursor);

  return accounts
    .filter(a => {
      const avail = parseFloat(a.available_balance?.value || 0);
      const hold = parseFloat(a.hold?.value || 0);
      return (avail + hold) > 0;
    })
    .map(a => ({
      currency: a.currency,
      available: parseFloat(a.available_balance?.value || 0),
      hold: parseFloat(a.hold?.value || 0),
      total: parseFloat(a.available_balance?.value || 0) + parseFloat(a.hold?.value || 0)
    }));
}

// Pre-fetch on startup
fetchAccountBalances().then(b => { balancesCache = { data: b, ts: Date.now() }; }).catch(() => {});

app.get('/get-balances', async (req, res) => {
  try {
    const now = Date.now();
    if (balancesCache.data && (now - balancesCache.ts) < BALANCES_CACHE_TTL) {
      return res.json({ success: true, balances: balancesCache.data });
    }
    const balances = await fetchAccountBalances();
    balancesCache = { data: balances, ts: now };
    res.json({ success: true, balances });
  } catch (e) {
    if (balancesCache.data) return res.json({ success: true, balances: balancesCache.data });
    res.json({ success: false, error: e.message });
  }
});

app.get('/get-holdings', async (req, res) => {
  try {
    // Собираем все аккаунты через пагинацию
    const accounts = [];
    let cursor = undefined;
    do {
      const params = { limit: 250 };
      if (cursor) params.cursor = cursor;
      const result = await client.listAccounts(params);
      const data = typeof result === 'string' ? JSON.parse(result) : result;
      accounts.push(...(data.accounts || []));
      cursor = data.has_next ? data.cursor : null;
    } while (cursor);

    // Только ненулевые
    const nonZero = accounts.filter(a => {
      const avail = parseFloat(a.available_balance?.value || 0);
      const hold = parseFloat(a.hold?.value || 0);
      return (avail + hold) > 0;
    });

    // Получаем цены батчами по 15 с паузой 100мс — защита от 429
    const BATCH = 15;
    const withPrices = [];
    for (let i = 0; i < nonZero.length; i += BATCH) {
      const batch = nonZero.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async a => {
        const currency = a.currency;
        const avail = parseFloat(a.available_balance?.value || 0);
        const hold = parseFloat(a.hold?.value || 0);
        const total = avail + hold;
        const price = await getPrice(currency);
        const usdValue = parseFloat((total * price).toFixed(4)) || 0;
        return { currency, available: avail, hold, total, price, usdValue };
      }));
      withPrices.push(...results);
      if (i + BATCH < nonZero.length) await sleep(100);
    }

    // Только монеты > $1 (USD/USDC тоже проходят если баланс > $1)
    const holdings = withPrices
      .filter(h => h.usdValue > 1)
      .sort((a, b) => b.usdValue - a.usdValue);

    res.json({ success: true, holdings });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

let balanceCache = { data: null, ts: 0 };
const BALANCE_CACHE_TTL = 10000; // 10 seconds

app.get('/get-balance', async (req, res) => {
  try {
    const now = Date.now();
    if (balanceCache.data !== null && (now - balanceCache.ts) < BALANCE_CACHE_TTL) {
      return res.json({ success: true, balance: balanceCache.data });
    }
    const result = await client.getAccount({ accountUuid: USD_ACCOUNT_UUID });
    const accountData = typeof result === 'string' ? JSON.parse(result) : result;

    if (accountData.account && accountData.account.available_balance) {
      const balance = parseFloat(accountData.account.available_balance.value) || 0;
      balanceCache = { data: balance, ts: now };
      res.json({ success: true, balance });
    } else {
      res.status(500).json({ success: false, error: 'Invalid account data structure' });
    }
  } catch (error) {
    console.error('Error fetching balance:', error);
    if (balanceCache.data !== null) {
      return res.json({ success: true, balance: balanceCache.data });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create limit buy order
app.post('/create-buy-order', async (req, res) => {
  try {
    const { productId, quoteSize, limitPrice } = req.body;
    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    // Calculate base_size (crypto amount) from USD and price
    const price = parseFloat(limitPrice);
    const usdAmount = parseFloat(quoteSize);

    // Fetch product info to get correct precision (base_increment & quote_increment)
    let baseDecimals = 8, quoteDecimals = 2;
    try {
      const prodRes = await fetch(`https://api.exchange.coinbase.com/products/${productId}`);
      if (prodRes.ok) {
        const prod = await prodRes.json();
        if (prod.base_increment) {
          const inc = prod.base_increment;
          baseDecimals = inc.includes('.') ? (inc.split('.')[1].replace(/0+$/, '').length || 0) : 0;
        }
        if (prod.quote_increment) {
          const inc = prod.quote_increment;
          quoteDecimals = inc.includes('.') ? (inc.split('.')[1].replace(/0+$/, '').length || 0) : 0;
        }
      }
    } catch (e) {
      console.warn('Could not fetch product info, using defaults:', e.message);
    }

    const baseSize = (usdAmount / price).toFixed(baseDecimals);
    const priceStr = price.toFixed(quoteDecimals);

    const orderData = {
      client_order_id: clientOrderId,
      product_id: productId,
      side: 'BUY',
      order_configuration: {
        limit_limit_gtc: {
          base_size: baseSize,
          limit_price: priceStr
        }
      }
    };

    console.log('Creating limit buy order:', orderData);
    const response = await client.createOrder(orderData);
    console.log('Buy order response:', JSON.stringify(response, null, 2));

    const parsed = typeof response === 'string' ? JSON.parse(response) : response;

    // Check for Coinbase error response
    if (parsed.success === false || parsed.error_response) {
      const errorMsg = parsed.error_response?.message || parsed.error_response?.error || parsed.error_response?.preview_failure_reason || 'Order rejected';
      console.error('Coinbase rejected order:', errorMsg);
      return res.json({ success: false, error: errorMsg, details: parsed });
    }

    // Check if we have success_response (means order was accepted)
    if (!parsed.success_response && !parsed.order_id) {
      console.error('No order ID in response:', parsed);
      return res.json({ success: false, error: 'No order ID returned', details: parsed });
    }

    const orderId = parsed.success_response?.order_id || parsed.order_id;
    console.log('Order created successfully, ID:', orderId);
    ordersCache.ts = 0; // invalidate cache
    balanceCache.ts = 0;
    res.json({ success: true, order: parsed, order_id: orderId });
  } catch (error) {
    console.error('Error creating buy order:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get latest orders (cached to avoid Coinbase rate limits)
let ordersCache = { data: null, ts: 0 };
const ORDERS_CACHE_TTL = 8000; // 8 seconds

app.get('/get-latest-orders', async (req, res) => {
  try {
    const now = Date.now();
    if (ordersCache.data && (now - ordersCache.ts) < ORDERS_CACHE_TTL) {
      return res.json({ success: true, orders: ordersCache.data });
    }
    const orders = await getLatestOrders();
    ordersCache = { data: orders, ts: now };
    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    // Return stale cache on error instead of failing
    if (ordersCache.data) {
      return res.json({ success: true, orders: ordersCache.data });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

async function getLatestOrders() {
  console.log('Fetching latest orders...');

  const openOrdersResult = await client.listOrders({
    limit: "350",
    order_status: ["OPEN"]
  });

  const otherOrdersResult = await client.listOrders({
    limit: "350",
    order_status: ["FILLED", "CANCELLED"]
  });

  const openOrders = typeof openOrdersResult === 'string' ? JSON.parse(openOrdersResult) : openOrdersResult;
  const otherOrders = typeof otherOrdersResult === 'string' ? JSON.parse(otherOrdersResult) : otherOrdersResult;

  const allOrders = [
    ...(openOrders.orders || []),
    ...(otherOrders.orders || [])
  ];

  // Нормализуем данные
  const normalizedOrders = allOrders.map(order => {
    const limitConfig = order.order_configuration?.limit_limit_gtc;
    const marketConfig = order.order_configuration?.market_market_ioc;

    return {
      order_id: order.order_id,
      product_id: order.product_id,
      side: order.side,
      order_type: order.order_type,
      status: order.status,
      created_time: order.created_time,
      filled_size: order.filled_size || '0',
      filled_value: order.filled_value || '0',
      average_filled_price: order.average_filled_price || '0',
      total_fees: order.total_fees || '0',
      total_value: order.total_value_after_fees || order.filled_value || '0',
      limit_price: limitConfig?.limit_price || null,
      order_configuration: order.order_configuration
    };
  });

  // Сортируем по дате (новые первыми)
  normalizedOrders.sort((a, b) => {
    const timeA = new Date(a.created_time).getTime() || 0;
    const timeB = new Date(b.created_time).getTime() || 0;
    return timeB - timeA;
  });

  console.log('Orders count:', normalizedOrders.length);
  return normalizedOrders;
}

// ========== CRYPTORANK API ==========

// Helper function for CryptoRank requests
async function cryptorankFetch(endpoint, params = {}) {
  const url = new URL(`${CRYPTORANK_BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const response = await fetch(url.toString(), {
    headers: { 'X-Api-Key': CRYPTORANK_API_KEY }
  });
  if (!response.ok) throw new Error(`CryptoRank API error: ${response.status}`);
  return response.json();
}

// API: CryptoRank Global Market Data (includes Fear & Greed, BTC dominance, etc.)
app.get('/api/cryptorank/global', async (req, res) => {
  try {
    const data = await cryptorankFetch('/global');
    res.json({ success: true, data: data.data });
  } catch (error) {
    console.error('CryptoRank global error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: CryptoRank Top Currencies
app.get('/api/cryptorank/currencies', async (req, res) => {
  try {
    const limit = req.query.limit || 20;
    const sortBy = req.query.sortBy || 'rank';
    const data = await cryptorankFetch('/currencies', { limit, sortBy, sortDirection: 'ASC' });
    res.json({ success: true, data: data.data });
  } catch (error) {
    console.error('CryptoRank currencies error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Research - Coinbase coins with CryptoRank v1 data
let researchCache = { data: null, ts: 0 };
const RESEARCH_CACHE_TTL = 300000; // 5 minutes
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'FRAX', 'USDS', 'PYUSD', 'EURC', 'EUR', 'GBP', 'CBETH']);

app.get('/api/research', async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh && researchCache.data && (now - researchCache.ts) < RESEARCH_CACHE_TTL) {
      return res.json({ success: true, coins: researchCache.data });
    }

    // Get Coinbase USD pairs
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const usdCoins = new Set(products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency)
      .filter(s => !STABLECOINS.has(s)));

    // Get CryptoRank v1 data (has percentChange fields)
    const crCoins = [];
    const r = await fetch(`https://api.cryptorank.io/v1/currencies?limit=1000&api_key=${CRYPTORANK_API_KEY}`);
    if (r.ok) {
      const d = await r.json();
      if (d.data) crCoins.push(...d.data);
    }

    // Match Coinbase coins with CryptoRank data
    const coins = [];
    for (const symbol of usdCoins) {
      const cr = crCoins.find(c => c.symbol === symbol);
      if (cr && cr.values?.USD) {
        const v = cr.values.USD;
        coins.push({
          symbol,
          name: cr.name,
          rank: cr.rank || 9999,
          price: v.price || 0,
          marketCap: v.marketCap || 0,
          volume24h: v.volume24h || 0,
          change24h: v.percentChange24h || 0,
          change7d: v.percentChange7d || 0,
          change30d: v.percentChange30d || 0,
        });
      }
    }

    coins.sort((a, b) => a.rank - b.rank);
    researchCache = { data: coins, ts: now };
    res.json({ success: true, coins });

    // Background: fetch Coinbase 24h volumes
    (async () => {
      for (let i = 0; i < coins.length; i += 2) {
        const batch = coins.slice(i, i + 2);
        await Promise.all(batch.map(async (coin) => {
          try {
            const sr = await fetch(`https://api.exchange.coinbase.com/products/${coin.symbol}-USD/stats`);
            if (sr.ok) {
              const stats = await sr.json();
              coin.volume24h = (parseFloat(stats.volume) || 0) * (parseFloat(stats.last) || coin.price);
            }
          } catch {}
        }));
        await sleep(800);
      }
      researchCache = { data: coins, ts: Date.now() };
      console.log('[RESEARCH] Coinbase volumes updated');
    })();
  } catch (error) {
    console.error('Research API error:', error);
    if (researchCache.data) return res.json({ success: true, coins: researchCache.data });
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Recovery Scanner - finds coins with big drop + early recovery
let recoveryCacheData = { data: null, ts: 0 };

// Background recovery scan
let recoveryScanRunning = false;
let recoveryScanProgress = 0; // 0-100
async function runRecoveryScan() {
  if (recoveryScanRunning) return;
  recoveryScanRunning = true;
  console.log('[RECOVERY] Scan started...');
  try {

    // Get Coinbase USD pairs
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const pairs = products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency);

    const results = [];
    const BATCH = 2;

    let scanned = 0, skipped429 = 0;
    for (let i = 0; i < pairs.length; i += BATCH) {
      const batch = pairs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (coin) => {
        try {
          // Get daily candles (last 30 days) with retry on 429
          let candles = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400`);
            if (r.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
            if (!r.ok) return;
            candles = await r.json();
            break;
          }
          if (!candles) { skipped429++; return; }
          if (!Array.isArray(candles) || candles.length < 10) return;
          scanned++;

          // Candles: [time, low, high, open, close, volume] — newest first
          const sorted = candles.slice(0, 30).reverse(); // oldest to newest
          const closes = sorted.map(c => parseFloat(c[4]));
          const volumes = sorted.map(c => parseFloat(c[5]));

          // Find the highest point in last 30 days
          let maxPrice = 0, maxIdx = 0;
          closes.forEach((p, i) => { if (p > maxPrice) { maxPrice = p; maxIdx = i; } });

          // Find the lowest point AFTER the peak
          let minPrice = Infinity, minIdx = 0;
          for (let j = maxIdx; j < closes.length; j++) {
            if (closes[j] < minPrice) { minPrice = closes[j]; minIdx = j; }
          }

          // Current price
          const currentPrice = closes[closes.length - 1];
          const dropPct = maxPrice > 0 ? ((minPrice - maxPrice) / maxPrice) * 100 : 0;
          const recoveryPct = minPrice > 0 ? ((currentPrice - minPrice) / minPrice) * 100 : 0;
          const fromPeakPct = maxPrice > 0 ? ((currentPrice - maxPrice) / maxPrice) * 100 : 0;
          const daysFromBottom = closes.length - 1 - minIdx;

          // Log first few coins for debug
          if (scanned <= 5) console.log(`[RECOVERY] ${coin}: drop=${dropPct.toFixed(1)}% rec=${recoveryPct.toFixed(1)}% days=${daysFromBottom} peak=${maxPrice} bot=${minPrice} cur=${currentPrice}`);

          // Filter: significant drop (>20%) AND some recovery (>2%) AND bottom was recent (last 15 days)
          if (dropPct < -15 && recoveryPct > 1 && daysFromBottom > 0 && daysFromBottom <= 20) {
            // Check trend: last 3 days going up
            const last3 = closes.slice(-3);
            const isRising = last3.length >= 3 && last3[2] > last3[0];

            // Average volume last 5 days vs previous 10 days
            const recentVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
            const prevVol = volumes.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
            const volIncrease = prevVol > 0 ? recentVol / prevVol : 1;

            // Score formula — prioritize best buy opportunities:
            // 1. Volume surge (strongest signal — big money entering)
            // 2. Rising trend (confirmed reversal)
            // 3. Fresh bottom (2-6 days = sweet spot)
            // 4. Drop size (bigger drop = more room to recover)
            // 5. Recovery % (shows momentum)
            // 6. Penalize low liquidity — get real 24h volume from stats
            let volume24hUsd = 0;
            try {
              for (let a = 0; a < 2; a++) {
                const sr = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/stats`);
                if (sr.status === 429) { await sleep(2000); continue; }
                if (sr.ok) { const st = await sr.json(); volume24hUsd = (parseFloat(st.volume) || 0) * currentPrice; }
                break;
              }
            } catch {}
            if (!volume24hUsd) volume24hUsd = (volumes[volumes.length - 1] || 0) * currentPrice;

            const freshBonus = daysFromBottom <= 6 ? 15 : daysFromBottom <= 10 ? 8 : 0;
            const volScore = Math.min(volIncrease * 12, 30);
            const trendScore = isRising ? 20 : 0;
            const dropScore = Math.min(Math.abs(dropPct) * 0.2, 15);
            const recoveryScore = Math.min(recoveryPct * 0.3, 15);
            const liquidityPenalty = volume24hUsd < 50000 ? -10 : volume24hUsd < 200000 ? -5 : 0;
            const score = volScore + trendScore + freshBonus + dropScore + recoveryScore + liquidityPenalty;

            if (results.length <= 5) console.log(`[RECOVERY] MATCH: ${coin} drop=${dropPct.toFixed(1)}% rec=${recoveryPct.toFixed(1)}% days=${daysFromBottom} score=${score.toFixed(1)}`);
            results.push({
              coin,
              currentPrice,
              peakPrice: maxPrice,
              bottomPrice: minPrice,
              dropPct: Math.round(dropPct * 100) / 100,
              recoveryPct: Math.round(recoveryPct * 100) / 100,
              fromPeakPct: Math.round(fromPeakPct * 100) / 100,
              daysFromBottom,
              isRising,
              volIncrease: Math.round(volIncrease * 100) / 100,
              volume24h: Math.round(volume24hUsd),
              score: Math.round(score * 10) / 10,
            });
          }
        } catch {}
      }));
      await sleep(1200);
      recoveryScanProgress = Math.round((i + BATCH) / pairs.length * 100);
      if (i % 50 === 0 && i > 0) console.log(`[RECOVERY] Progress: ${i}/${pairs.length} (${recoveryScanProgress}%)...`);
    }

    results.sort((a, b) => b.score - a.score);
    recoveryCacheData = { data: results, ts: Date.now() };
    recoveryScanProgress = 100;
    console.log(`[RECOVERY] Scan complete: ${results.length} found (scanned: ${scanned}/${pairs.length}, 429s: ${skipped429})`);
  } catch (error) {
    console.error('Recovery scan error:', error);
  } finally {
    recoveryScanRunning = false;
  }
}

// Auto-scan on startup (delayed to avoid 429 conflicts)
setTimeout(runRecoveryScan, 15000);
// Re-scan every 30 minutes
setInterval(runRecoveryScan, 30 * 60 * 1000);

app.get('/api/recovery-scan', async (req, res) => {
  try {
    if (req.query.refresh === '1') {
      runRecoveryScan();
    }
    const lastScan = recoveryCacheData.ts ? Math.round((Date.now() - recoveryCacheData.ts) / 1000) : null;
    res.json({
      success: true,
      results: recoveryCacheData.data || [],
      scanning: recoveryScanRunning,
      scanProgress: recoveryScanProgress,
      lastScanAgo: lastScan
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: CryptoRank Currency Details
app.get('/api/cryptorank/currency/:key', async (req, res) => {
  try {
    const data = await cryptorankFetch(`/currencies/${req.params.key}`);
    res.json({ success: true, data: data.data });
  } catch (error) {
    console.error('CryptoRank currency error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: CryptoRank Top Gainers/Losers
app.get('/api/cryptorank/top-movers', async (req, res) => {
  try {
    const [gainers, losers] = await Promise.all([
      cryptorankFetch('/currencies', { limit: 10, sortBy: 'percentChange24h', sortDirection: 'DESC' }),
      cryptorankFetch('/currencies', { limit: 10, sortBy: 'percentChange24h', sortDirection: 'ASC' })
    ]);
    res.json({ success: true, gainers: gainers.data, losers: losers.data });
  } catch (error) {
    console.error('CryptoRank top-movers error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Get order status (for Trading Bot)
app.get('/get-order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await client.getOrder({ orderId });
    const raw = typeof result === 'string' ? JSON.parse(result) : result;
    const order = raw.order || raw;
    res.json({
      success: true,
      status: order.status,
      filled_size: order.filled_size || '0',
      average_filled_price: order.average_filled_price || '0',
    });
  } catch (error) {
    console.error('Error getting order status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server — check port first, then listen
const net = require('net');

function checkPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => { tester.close(); resolve(true); })
      .listen(port);
  });
}

async function startServer(retries = 10) {
  for (let i = 0; i < retries; i++) {
    const free = await checkPort(PORT);
    if (free) {
      server = app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
      });
      server.keepAliveTimeout = 65000;
      server.headersTimeout = 66000;
      server.on('error', (err) => console.error('[SERVER ERROR]', err.message));
      return;
    }
    console.log(`[STARTUP] Port ${PORT} busy, waiting... (${i + 1}/${retries})`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error(`[ERROR] Port ${PORT} still in use after ${retries} attempts. Exiting.`);
  process.exit(1);
}

startServer();
