require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { RESTClient } = require('./cb/dist/rest/index.js');
const predictor = require('./src/predictor');

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
    const { productId, quoteSize, limitPrice, orderType, stopPrice } = req.body;
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

    let orderData;
    if (orderType === 'stop_limit') {
      const stopVal = parseFloat(stopPrice || limitPrice);
      const stopPriceStr = stopVal.toFixed(quoteDecimals);
      orderData = {
        client_order_id: clientOrderId,
        product_id: productId,
        side: 'BUY',
        order_configuration: {
          stop_limit_stop_limit_gtc: {
            base_size: baseSize,
            limit_price: priceStr,
            stop_price: stopPriceStr,
            stop_direction: 'STOP_DIRECTION_STOP_UP'
          }
        }
      };
      console.log('Creating stop-limit buy order:', orderData);
    } else {
      orderData = {
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
    }
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

// Global Coinbase volume cache — shared between Research and Recovery
const cbVolumeCache = new Map();
let cbVolumeFetching = false;
let cbVolumeProgress = 0;
let cbVolumeLastUpdate = 0;
const cbVolumeCacheFile = path.join(__dirname, 'volume-cache.json');

// Load cached volumes from file on startup
try {
  if (fs.existsSync(cbVolumeCacheFile)) {
    const saved = JSON.parse(fs.readFileSync(cbVolumeCacheFile, 'utf8'));
    if (saved.data) {
      Object.entries(saved.data).forEach(([k, v]) => cbVolumeCache.set(k, v));
      cbVolumeLastUpdate = saved.ts || 0;
      console.log(`[VOLUMES] Loaded ${cbVolumeCache.size} cached volumes from file`);
    }
  }
} catch {}

async function fetchAllCbVolumes() {
  if (cbVolumeFetching) return;
  cbVolumeFetching = true;
  console.log('[VOLUMES] Fetching Coinbase volumes...');
  try {
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const pairs = products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency);

    let fetched = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      const batch = pairs.slice(i, i + 2);
      await Promise.all(batch.map(async (coin) => {
        try {
          const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/stats`);
          if (r.status === 429) return;
          if (r.ok) {
            const s = await r.json();
            const vol = (parseFloat(s.volume) || 0) * (parseFloat(s.last) || 0);
            if (vol > 0) { cbVolumeCache.set(coin, vol); fetched++; }
          }
        } catch {}
      }));
      await sleep(1000);
      cbVolumeProgress = Math.round((i + 2) / pairs.length * 100);
    }
    cbVolumeProgress = 100;
    cbVolumeLastUpdate = Date.now();
    console.log(`[VOLUMES] Done: ${fetched}/${pairs.length} volumes cached`);
    // Save to file for persistence across restarts
    try {
      const data = {};
      cbVolumeCache.forEach((v, k) => { data[k] = v; });
      fs.writeFileSync(cbVolumeCacheFile, JSON.stringify({ data, ts: cbVolumeLastUpdate }));
    } catch {}
    researchCache.ts = 0;
  } catch (e) {
    console.error('[VOLUMES] Error:', e.message);
  } finally {
    cbVolumeFetching = false;
  }
}

// Fetch volumes 30s after start, then every 30min
setTimeout(fetchAllCbVolumes, 30000);
setInterval(fetchAllCbVolumes, 30 * 60 * 1000);

// API: Research - 100% Coinbase data
let researchCache = { data: null, ts: 0 };
const RESEARCH_CACHE_TTL = 300000; // 5 minutes
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD', 'FRAX', 'USDS', 'PYUSD', 'EURC', 'EUR', 'GBP', 'CBETH']);

// Research data cache (from background scan)
let researchCoinsCache = [];
let researchScanRunning = false;
let researchScanProgress = 0;
let researchLastScan = 0;

async function runResearchScan() {
  if (researchScanRunning) return;
  researchScanRunning = true;
  researchScanProgress = 0;
  console.log('[RESEARCH] Scan started...');
  try {
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const pairs = products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency)
      .filter(s => !STABLECOINS.has(s));

    const coins = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const batch = pairs.slice(i, i + 2);
      await Promise.all(batch.map(async (coin) => {
        try {
          // Get daily candles for 24h, 7d, 30d changes
          const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=86400`);
          if (!r.ok) return;
          const candles = await r.json();
          if (!Array.isArray(candles) || candles.length < 2) return;

          const sorted = candles.slice(0, 30).reverse(); // oldest to newest
          const closes = sorted.map(c => parseFloat(c[4]));
          const currentPrice = closes[closes.length - 1];

          // Calculate changes
          const change24h = closes.length >= 2 ? ((currentPrice - closes[closes.length - 2]) / closes[closes.length - 2] * 100) : 0;
          const change7d = closes.length >= 7 ? ((currentPrice - closes[closes.length - 7]) / closes[closes.length - 7] * 100) : 0;
          const change30d = closes.length >= 30 ? ((currentPrice - closes[0]) / closes[0] * 100) : (closes.length >= 2 ? ((currentPrice - closes[0]) / closes[0] * 100) : 0);

          // Volume and market cap from cache
          const volume24h = cbVolumeCache.get(coin) || 0;

          coins.push({
            symbol: coin,
            name: coin,
            price: currentPrice,
            marketCap: 0,
            volume24h,
            change24h: Math.round(change24h * 100) / 100,
            change7d: Math.round(change7d * 100) / 100,
            change30d: Math.round(change30d * 100) / 100,
          });
        } catch {}
      }));
      await sleep(800);
      researchScanProgress = Math.round((i + 2) / pairs.length * 100);
    }

    // Sort by volume desc
    coins.sort((a, b) => b.volume24h - a.volume24h);
    researchCoinsCache = coins;
    researchLastScan = Date.now();
    researchScanProgress = 100;
    console.log(`[RESEARCH] Scan complete: ${coins.length} coins`);
  } catch (e) {
    console.error('[RESEARCH] Error:', e.message);
  } finally {
    researchScanRunning = false;
  }
}

// Auto-scan 20s after start, then every 30min
setTimeout(runResearchScan, 20000);
setInterval(runResearchScan, 30 * 60 * 1000);

app.get('/api/research', (req, res) => {
  if (req.query.refresh === '1' && !researchScanRunning) {
    runResearchScan();
  }
  const lastScan = researchLastScan ? Math.round((Date.now() - researchLastScan) / 1000) : null;
  res.json({
    success: true,
    coins: researchCoinsCache,
    scanning: researchScanRunning,
    scanProgress: researchScanProgress,
    lastScanAgo: lastScan,
    volumesReady: !researchScanRunning && researchCoinsCache.length > 0,
    volumesLoading: researchScanRunning,
    volumeProgress: researchScanProgress,
  });
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
            // 6. Penalize low liquidity — use cached volume or candle fallback
            let volume24hUsd = cbVolumeCache.get(coin) || 0;
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

// API: Dip Scanner — finds coins at bottom on 15min candles
let dipCacheData = { data: null, ts: 0 };
let dipScanRunning = false;
let dipScanProgress = 0;

async function runDipScan() {
  if (dipScanRunning) return;
  dipScanRunning = true;
  dipScanProgress = 0;
  console.log('[DIP] Scan started...');
  try {
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const pairs = products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency)
      .filter(s => !STABLECOINS.has(s));

    const results = [];
    let scanned = 0;

    for (let i = 0; i < pairs.length; i += 2) {
      const batch = pairs.slice(i, i + 2);
      await Promise.all(batch.map(async (coin) => {
        try {
          // 15-min candles (last ~24h = 96 candles)
          const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/candles?granularity=900`);
          if (!r.ok) return;
          const candles = await r.json();
          if (!Array.isArray(candles) || candles.length < 20) return;
          scanned++;

          const sorted = candles.slice(0, 96).reverse(); // oldest to newest
          const closes = sorted.map(c => parseFloat(c[4]));
          const lows = sorted.map(c => parseFloat(c[1]));
          const highs = sorted.map(c => parseFloat(c[2]));
          const opens = sorted.map(c => parseFloat(c[3]));
          const volumes = sorted.map(c => parseFloat(c[5]));

          const currentPrice = closes[closes.length - 1];

          // Find peak in last 24h (96 candles)
          const peak = Math.max(...highs);
          // Find bottom in last 24h
          const bottom = Math.min(...lows);
          const bottomIdx = lows.indexOf(bottom);

          // Drop from peak
          const dropPct = ((bottom - peak) / peak) * 100;

          // How close to bottom now (0% = at bottom, 100% = at peak)
          const range = peak - bottom;
          const fromBottom = range > 0 ? ((currentPrice - bottom) / range) * 100 : 50;

          // Candles since bottom
          const candlesSinceBottom = closes.length - 1 - bottomIdx;

          // Last 3 candles trend
          const last3 = closes.slice(-3);
          const last3Rising = last3.length >= 3 && last3[2] > last3[0];
          const lastGreen = closes.length >= 2 && closes[closes.length - 1] > opens[opens.length - 1];

          // Recent volume vs average
          const recentVol = volumes.slice(-4).reduce((a, b) => a + b, 0) / 4;
          const avgVol = volumes.slice(0, -4).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 4);
          const volSurge = avgVol > 0 ? recentVol / avgVol : 1;

          // Volume in USD
          const vol24h = cbVolumeCache.get(coin) || 0;

          // Filter: significant drop, near bottom, recent bottom
          if (dropPct < -5 && fromBottom < 25 && candlesSinceBottom <= 20 && candlesSinceBottom >= 1) {
            // Score
            const dropScore = Math.min(Math.abs(dropPct) * 1.5, 30);
            const nearBottomScore = Math.max(0, 25 - fromBottom); // closer to bottom = higher
            const freshScore = candlesSinceBottom <= 5 ? 20 : candlesSinceBottom <= 10 ? 12 : 5;
            const trendScore = last3Rising ? 15 : lastGreen ? 8 : 0;
            const volScore = Math.min(volSurge * 8, 20);
            const liqPenalty = vol24h < 50000 ? -10 : vol24h < 200000 ? -5 : 0;
            const score = dropScore + nearBottomScore + freshScore + trendScore + volScore + liqPenalty;

            results.push({
              coin,
              currentPrice,
              peakPrice: peak,
              bottomPrice: bottom,
              dropPct: Math.round(dropPct * 100) / 100,
              fromBottom: Math.round(fromBottom * 10) / 10,
              candlesSinceBottom,
              minutesSinceBottom: candlesSinceBottom * 15,
              isRising: last3Rising,
              lastGreen,
              volSurge: Math.round(volSurge * 100) / 100,
              volume24h: vol24h,
              score: Math.round(score * 10) / 10,
            });
          }
        } catch {}
      }));
      await sleep(800);
      dipScanProgress = Math.round((i + 2) / pairs.length * 100);
    }

    results.sort((a, b) => b.score - a.score);
    dipCacheData = { data: results, ts: Date.now() };
    dipScanProgress = 100;
    console.log(`[DIP] Scan complete: ${results.length} found (scanned: ${scanned}/${pairs.length})`);
  } catch (e) {
    console.error('[DIP] Error:', e.message);
  } finally {
    dipScanRunning = false;
  }
}

// Auto-scan 45s after start, then every 15min
setTimeout(runDipScan, 45000);
setInterval(runDipScan, 15 * 60 * 1000);

app.get('/api/dip-scan', (req, res) => {
  if (req.query.refresh === '1' && !dipScanRunning) runDipScan();
  const lastScan = dipCacheData.ts ? Math.round((Date.now() - dipCacheData.ts) / 1000) : null;
  res.json({
    success: true,
    results: dipCacheData.data || [],
    scanning: dipScanRunning,
    scanProgress: dipScanProgress,
    lastScanAgo: lastScan,
  });
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

// ========== TOP GAINERS (Coinbase) ==========

let topGainersCache = { data: [], fetchedAt: 0 };
const TOP_GAINERS_TTL = 60_000;

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0, d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  if (al === 0) return 100;
  return Math.round(100 - 100 / (1 + ag / al));
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcDetailedGainerScore(pct, volUsd, rsi, fromHighPct, emaAligned, volSurge) {
  let s = 50;

  // 1. RSI condition (cool-down vs overbought)
  if (rsi > 80) s -= 30;
  else if (rsi > 72) s -= 15;
  else if (rsi >= 48 && rsi <= 65) s += 15;
  else if (rsi >= 35 && rsi < 48) s += 8;
  else s -= 10;

  // 2. 24h pump size
  if (pct > 50) s -= 35;
  else if (pct > 35) s -= 22;
  else if (pct >= 8 && pct <= 25) s += 15;
  else if (pct > 0 && pct < 8) s += 5;

  // 3. Distance from 24h High (healthy pullback vs breakout vs dump)
  if (fromHighPct < 2.0) {
    s += 10; // Breakout candidate
    if (volSurge > 1.8) s += 10;
  } else if (fromHighPct >= 2.0 && fromHighPct <= 12.0) {
    s += 15; // Healthy pullback
    if (volSurge < 1.1) s += 5; // Low volume pullback is bullish
  } else {
    s -= 25; // Failed pump / dumping
  }

  // 4. Short-term trend alignment (1h EMA9 > EMA21)
  if (emaAligned) s += 10;
  else s -= 12;

  // 5. Volume & Liquidity
  if (volUsd < 150_000) s -= 30;
  else if (volUsd < 500_000) s -= 15;
  else if (volUsd > 10_000_000) s += 15;
  else if (volUsd > 2_000_000) s += 8;

  if (volSurge > 2.0) s += 8;

  return Math.max(0, Math.min(100, Math.round(s)));
}

async function fetchTopGainers() {
  const CB = 'https://api.exchange.coinbase.com';
  const prodRes = await fetch(`${CB}/products?type=SPOT`);
  const products = await prodRes.json();
  const usdPairs = products.filter(p =>
    p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled
  ).map(p => p.id);

  // Fetch stats in parallel batches of 40
  const BATCH = 40;
  const results = [];
  for (let i = 0; i < usdPairs.length; i += BATCH) {
    const batch = usdPairs.slice(i, i + BATCH);
    const stats = await Promise.all(batch.map(async id => {
      try {
        const r = await fetch(`${CB}/products/${id}/stats`);
        const s = await r.json();
        const open = parseFloat(s.open), last = parseFloat(s.last), high = parseFloat(s.high);
        const volUsd = parseFloat(s.volume) * last;
        if (!open || !last) return null;
        const fromHighPct = high ? ((high - last) / high) * 100 : 0;
        return { coin: id.replace('-USD', ''), price: last, pct: (last - open) / open * 100, volUsd, fromHighPct };
      } catch { return null; }
    }));
    results.push(...stats.filter(Boolean));
    if (i + BATCH < usdPairs.length) await new Promise(r => setTimeout(r, 100));
  }
  results.sort((a, b) => b.pct - a.pct);
  const top20 = results.slice(0, 20);

  // Fetch 1h candles for top 20 to compute RSI, EMA, and volume surge
  await Promise.all(top20.map(async g => {
    try {
      const r = await fetch(`${CB}/products/${g.coin}-USD/candles?granularity=3600`);
      const candles = await r.json();
      if (!Array.isArray(candles) || candles.length < 30) {
        g.rsi = 50;
        g.emaAligned = false;
        g.volSurge = 1.0;
      } else {
        // candles: [time, low, high, open, close, volume] — newest first
        const closes = candles.slice(0, 50).reverse().map(c => c[4]);
        g.rsi = calcRSI(closes);

        const ema9 = calcEMA(closes, 9);
        const ema21 = calcEMA(closes, 21);
        g.emaAligned = (ema9 !== null && ema21 !== null) ? (ema9 > ema21) : false;

        const currentVol = candles[0][5];
        const pastVols = candles.slice(1, Math.min(candles.length, 25)).map(c => c[5]);
        const avgVol = pastVols.length > 0 ? pastVols.reduce((a, b) => a + b, 0) / pastVols.length : 0;
        g.volSurge = avgVol > 0 ? (currentVol / avgVol) : 1.0;
      }
    } catch {
      g.rsi = 50;
      g.emaAligned = false;
      g.volSurge = 1.0;
    }
    g.score = calcDetailedGainerScore(g.pct, g.volUsd, g.rsi, g.fromHighPct, g.emaAligned, g.volSurge);
  }));

  return top20;
}

app.get('/api/top-gainers', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === 'true';
    if (!force && now - topGainersCache.fetchedAt < TOP_GAINERS_TTL && topGainersCache.data.length) {
      return res.json({ success: true, gainers: topGainersCache.data, fetchedAt: topGainersCache.fetchedAt, cached: true });
    }
    const gainers = await fetchTopGainers();
    topGainersCache = { data: gainers, fetchedAt: Date.now() };
    res.json({ success: true, gainers, fetchedAt: topGainersCache.fetchedAt, cached: false });
  } catch (e) {
    console.error('[top-gainers]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== TOP VOLUME (24h volume leaders) ==========

let topVolumeCache = { data: [], fetchedAt: 0 };
const TOP_VOLUME_TTL = 60_000;

const STABLECOINS = new Set(['USDT','USDC','DAI','BUSD','TUSD','GUSD','USDP','FRAX','LUSD','CRVUSD','PYUSD','EURC','FDUSD','USDS','USDM','ALUSD','SUSD','MUSD','DOLA','RAI']);

async function fetchTopVolume() {
  const CB = 'https://api.exchange.coinbase.com';
  const prodRes = await fetch(`${CB}/products?type=SPOT`);
  const products = await prodRes.json();
  const usdPairs = products.filter(p =>
    p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled &&
    !STABLECOINS.has(p.base_currency)
  ).map(p => p.id);

  const BATCH = 40;
  const results = [];
  for (let i = 0; i < usdPairs.length; i += BATCH) {
    const batch = usdPairs.slice(i, i + BATCH);
    const stats = await Promise.all(batch.map(async id => {
      try {
        const r = await fetch(`${CB}/products/${id}/stats`);
        const s = await r.json();
        const open = parseFloat(s.open), last = parseFloat(s.last);
        const vol = parseFloat(s.volume);
        const volUsd = vol * last;
        if (!last || !volUsd) return null;
        const pct24h = open ? (last - open) / open * 100 : 0;
        return { coin: id.replace('-USD', ''), price: last, pct24h, volUsd };
      } catch { return null; }
    }));
    results.push(...stats.filter(Boolean));
    if (i + BATCH < usdPairs.length) await new Promise(r => setTimeout(r, 80));
  }
  results.sort((a, b) => b.volUsd - a.volUsd);
  const top20 = results.slice(0, 20);

  // Fetch order book depth ±2% for each coin (sequentially to avoid rate limits)
  for (const c of top20) {
    try {
      const r = await fetch(`${CB}/products/${c.coin}-USD/book?level=3`);
      if (!r.ok) { c.depth2Buy = 0; c.depth2Sell = 0; continue; }
      const book = await r.json();
      if (!Array.isArray(book.bids)) { c.depth2Buy = 0; c.depth2Sell = 0; continue; }
      const mid = c.price;
      const lowBound = mid * 0.98;
      const highBound = mid * 1.02;
      let buyDepth = 0, sellDepth = 0;
      for (const entry of (book.bids || [])) {
        const p = parseFloat(entry[0]), s = parseFloat(entry[1]);
        if (p >= lowBound) buyDepth += p * s;
      }
      for (const entry of (book.asks || [])) {
        const p = parseFloat(entry[0]), s = parseFloat(entry[1]);
        if (p <= highBound) sellDepth += p * s;
      }
      c.depth2Buy = buyDepth;
      c.depth2Sell = sellDepth;
    } catch { c.depth2Buy = 0; c.depth2Sell = 0; }
    await new Promise(r => setTimeout(r, 60));
  }

  return top20;
}

app.get('/api/top-volume', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === 'true';
    if (!force && now - topVolumeCache.fetchedAt < TOP_VOLUME_TTL && topVolumeCache.data.length) {
      return res.json({ success: true, coins: topVolumeCache.data, fetchedAt: topVolumeCache.fetchedAt, cached: true });
    }
    const coins = await fetchTopVolume();
    topVolumeCache = { data: coins, fetchedAt: Date.now() };
    res.json({ success: true, coins, fetchedAt: topVolumeCache.fetchedAt, cached: false });
  } catch (e) {
    console.error('[top-volume]', e.message);
    if (topVolumeCache.data.length) return res.json({ success: true, coins: topVolumeCache.data, stale: true });
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== TOP RECOVERIES (30d losers showing reversal) ==========

let topRecoveriesCache = { data: [], fetchedAt: 0 };
const TOP_RECOVERIES_TTL = 60_000;

function calcDetailedReversalScore(params) {
  const {
    pct24h,
    pct30d,
    volUsd,
    rsi,
    distFromBottom,
    ema10Cross,
    volIncreaseDaily,
    emaAligned1h,
    volRatio,
    freshEmaCross,
    freshEma50Breakout,
    wasOversold,
    aboveEma50,
    // New parameters:
    buyPressureRatio,
    isBullStructure,
    makingHigherLows,
    emaRibbonAlign,
    isRsiRisingBull
  } = params;

  let s = 30; // baseline score

  // 1. Drop depth (30d)
  if (pct30d < -45) s += 15;
  else if (pct30d < -25) s += 20; // Sweet spot for recovery
  else if (pct30d < -12) s += 10;
  else s -= 15;

  // 2. 24h change (momentum)
  if (pct24h >= 2.0 && pct24h <= 10.0) s += 18; // Strong but healthy bounce
  else if (pct24h >= 0.5 && pct24h < 2.0) s += 8;  // Early recovery sign
  else if (pct24h > 10.0 && pct24h <= 20.0) s += 12; // High momentum
  else if (pct24h > 20.0) s += 2;  // Risk of chasing
  else s -= 15; // flat or negative 24h is not reversing

  // 3. Distance from 30d Bottom
  if (distFromBottom >= 2.0 && distFromBottom <= 15.0) {
    s += 15; // Perfect bounce range
  } else if (distFromBottom > 15.0 && distFromBottom <= 25.0) {
    s += 8;
  } else if (distFromBottom > 25.0) {
    s -= 15; // Extended recovery, potential pullback
  } else {
    s -= 5;  // At absolute low, no bounce yet
  }

  // 4. Daily Trend Reversal
  if (ema10Cross) s += 10;
  else s -= 3;

  // 5. Daily Volume surge
  if (volIncreaseDaily > 1.4) s += 10;
  else if (volIncreaseDaily > 1.0) s += 3;
  else s -= 5;

  // 6. Hourly Trend & Crossovers
  if (emaAligned1h) s += 12;
  else s -= 8;

  if (freshEmaCross) s += 6; // Bonus for fresh EMA9/21 cross

  if (aboveEma50) s += 10;
  else s -= 5;

  if (freshEma50Breakout) s += 5; // Bonus for fresh breakout above 50h EMA

  // 7. Hourly Volume surge
  if (volRatio > 1.8) s += 15;
  else if (volRatio > 1.2) s += 8;
  else if (volRatio < 0.8) s -= 10;

  // 8. Hourly RSI state
  if (rsi >= 35 && rsi <= 55) {
    s += 10;
    if (wasOversold && rsi >= 32) s += 8; // Oversold bounce bonus
  } else if (rsi > 55 && rsi <= 68) {
    s += 4;
  } else if (rsi > 68) {
    s -= 12; // Overbought locally
  } else if (rsi < 35) {
    s += 4; // oversold, possible value, but risky
  }

  // 9. Liquidity (24H Vol)
  if (volUsd < 150_000) s -= 35;
  else if (volUsd < 250_000) s -= 20;
  else if (volUsd < 500_000) s -= 10;
  else if (volUsd > 1_000_000) s += 15; // Liquid, safer entry

  // 10. Trend Alignment (Ribbon)
  if (emaRibbonAlign) s += 10;

  // 11. Market Structure
  if (isBullStructure) s += 12;
  else if (makingHigherLows) s += 6;

  // 12. Buying Volume Pressure
  if (buyPressureRatio > 1.35) s += 10;
  else if (buyPressureRatio > 1.2) s += 5;

  // 13. RSI Momentum
  if (isRsiRisingBull) s += 6;

  return Math.max(0, Math.min(100, Math.round(s)));
}

async function fetchTopRecoveries() {
  const CB = 'https://api.exchange.coinbase.com';
  const prodRes = await fetch(`${CB}/products?type=SPOT`);
  const products = await prodRes.json();
  const usdPairs = products.filter(p =>
    p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled
  ).map(p => p.id);

  const BATCH = 40;

  // Step 1: 24h stats for all USD pairs
  const stats24 = [];
  for (let i = 0; i < usdPairs.length; i += BATCH) {
    const batch = usdPairs.slice(i, i + BATCH);
    const res = await Promise.all(batch.map(async id => {
      try {
        const r = await fetch(`${CB}/products/${id}/stats`);
        const s = await r.json();
        const open = parseFloat(s.open), last = parseFloat(s.last);
        const volUsd = parseFloat(s.volume) * last;
        if (!open || !last) return null;
        return { coin: id.replace('-USD', ''), price: last, pct24h: (last - open) / open * 100, volUsd };
      } catch { return null; }
    }));
    stats24.push(...res.filter(Boolean));
    if (i + BATCH < usdPairs.length) await new Promise(r => setTimeout(r, 100));
  }

  // Step 2: keep only candidates that look like reversals (modest 24h gain, decent vol)
  const candidates = stats24
    .filter(s => s.pct24h >= 0.3 && s.pct24h <= 25 && s.volUsd > 100_000)
    .sort((a, b) => b.volUsd - a.volUsd)
    .slice(0, 80);

  // Step 3: 30d daily candles for candidates
  const withMonth = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const res = await Promise.all(batch.map(async g => {
      try {
        const r = await fetch(`${CB}/products/${g.coin}-USD/candles?granularity=86400`);
        const candles = await r.json();
        if (!Array.isArray(candles) || candles.length < 20) return null;
        // candles: [time, low, high, open, close, volume] newest first
        const idx = Math.min(candles.length - 1, 29);
        const close30 = candles[idx][4];
        const closeNow = candles[0][4];
        if (!close30) return null;
        g.pct30d = (closeNow - close30) / close30 * 100;

        // Calculate distance from 30d bottom
        const slice30 = candles.slice(0, idx + 1);
        const low30 = Math.min(...slice30.map(c => c[1])); // low is index 1
        g.distFromBottom = low30 ? ((closeNow - low30) / low30) * 100 : 0;

        // Calculate daily EMA10 cross
        const dailyCloses = candles.slice(0, Math.min(candles.length, 50)).reverse().map(c => c[4]);
        const dailyEma10 = calcEMA(dailyCloses, 10);
        g.ema10Cross = dailyEma10 !== null ? (closeNow > dailyEma10) : false;

        // Calculate daily volume increase
        const vol3d = candles.slice(0, Math.min(candles.length, 3)).map(c => c[5]).reduce((a, b) => a + b, 0) / Math.min(candles.length, 3);
        const volPrev = candles.slice(3, idx + 1).map(c => c[5]).reduce((a, b) => a + b, 0) / (idx - 2);
        g.volIncreaseDaily = volPrev > 0 ? (vol3d / volPrev) : 1.0;

        return g;
      } catch { return null; }
    }));
    withMonth.push(...res.filter(Boolean));
    if (i + BATCH < candidates.length) await new Promise(r => setTimeout(r, 100));
  }

  // Step 4: filter true 30d losers
  const losers = withMonth.filter(g => g.pct30d < -10);

  // Step 5: 1h RSI and 1h EMA alignment for losers
  const prevScores = new Map((topRecoveriesCache.data || []).map(g => [g.coin, g.score]));

  await Promise.all(losers.map(async g => {
    try {
      const r = await fetch(`${CB}/products/${g.coin}-USD/candles?granularity=3600`);
      const candles = await r.json();
      if (!Array.isArray(candles) || candles.length < 55) {
        g.rsi = 50;
        g.emaAligned1h = false;
        g.signals = [];
        g.score = 30;
      } else {
        const slice100 = candles.slice(0, 100);
        const reversedCandles = slice100.reverse();
        const closes = reversedCandles.map(c => c[4]);
        const vols = reversedCandles.map(c => c[5]);

        g.rsi = calcRSI(closes);

        const ema9 = calcEMA(closes, 9);
        const ema21 = calcEMA(closes, 21);
        const ema50 = calcEMA(closes, 50);

        g.emaAligned1h = (ema9 !== null && ema21 !== null) ? (ema9 > ema21) : false;

        const prevEma9 = calcEMA(closes.slice(0, -1), 9);
        const prevEma21 = calcEMA(closes.slice(0, -1), 21);
        const prevEma50 = calcEMA(closes.slice(0, -1), 50);

        const closeNow = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2];

        const freshEmaCross = (ema9 !== null && ema21 !== null && prevEma9 !== null && prevEma21 !== null)
          ? (prevEma9 <= prevEma21 && ema9 > ema21) : false;

        const aboveEma50 = (ema50 !== null) ? (closeNow > ema50) : false;
        const freshEma50Breakout = (ema50 !== null && prevEma50 !== null)
          ? (prevClose <= prevEma50 && closeNow > ema50) : false;

        // Vol ratio (last 4h vs hist)
        let volRatio = 1.0;
        if (vols.length >= 10) {
          const volLast4 = vols.slice(-4).reduce((a, b) => a + b, 0) / 4;
          const histVols = vols.slice(0, vols.length - 4);
          const volPrevAvg = histVols.reduce((a, b) => a + b, 0) / histVols.length;
          volRatio = volPrevAvg > 0 ? (volLast4 / volPrevAvg) : 1.0;
        }

        // Was oversold in last 24 hours
        let wasOversold = false;
        const rsis = [];
        for (let i = Math.max(15, closes.length - 24); i <= closes.length; i++) {
          rsis.push(calcRSI(closes.slice(0, i)));
        }
        wasOversold = rsis.some(r => r < 30);

        // Up/down hour buying volume pressure
        let buyPressureRatio = 1.0;
        let upCount = 0;
        if (reversedCandles.length >= 24) {
          const last24 = reversedCandles.slice(-24);
          let volUp = 0, countUp = 0;
          let volDown = 0, countDown = 0;
          last24.forEach(c => {
            const open = c[3], close = c[4], vol = c[5];
            if (close > open) {
              volUp += vol;
              countUp++;
            } else {
              volDown += vol;
              countDown++;
            }
          });
          const avgVolUp = countUp > 0 ? (volUp / countUp) : 0;
          const avgVolDown = countDown > 0 ? (volDown / countDown) : 0;
          buyPressureRatio = avgVolDown > 0 ? (avgVolUp / avgVolDown) : 1.0;
          upCount = countUp;
        }

        // Market structure check (last 24h)
        let isBullStructure = false;
        let makingHigherLows = false;
        if (reversedCandles.length >= 24) {
          const last24 = reversedCandles.slice(-24);
          const block1 = last24.slice(0, 12);
          const block2 = last24.slice(12, 24);
          const low1 = Math.min(...block1.map(c => c[1])); // low price
          const low2 = Math.min(...block2.map(c => c[1]));
          const high1 = Math.max(...block1.map(c => c[2])); // high price
          const high2 = Math.max(...block2.map(c => c[2]));

          makingHigherLows = low2 > low1;
          isBullStructure = makingHigherLows && (high2 > high1);
        }

        // EMA Ribbon Alignment
        const emaRibbonAlign = (ema9 !== null && ema21 !== null && ema50 !== null)
          ? (ema9 > ema21 && ema21 > ema50) : false;

        // RSI Momentum
        const prevRsi = calcRSI(closes.slice(0, -1));
        const isRsiRisingBull = (g.rsi > 50 && g.rsi > prevRsi);

        // Build signals array
        const signals = [];
        if (g.pct30d < -30) signals.push("Deep Discount");
        
        if (volRatio > 1.8) signals.push("Vol Surge");
        else if (volRatio > 1.2) signals.push("Accumulating");

        if (freshEmaCross) signals.push("EMA Cross");
        else if (g.emaAligned1h) signals.push("1H Uptrend");

        if (freshEma50Breakout) signals.push("EMA50 Breakout");
        else if (aboveEma50) signals.push("Above EMA50");

        if (wasOversold && g.rsi >= 32 && g.rsi <= 55) signals.push("Oversold Bounce");

        // New indicators added to signals:
        if (emaRibbonAlign) signals.push("Bull Ribbon");
        if (isBullStructure) signals.push("Bull Structure");
        else if (makingHigherLows) signals.push("Higher Lows");
        
        if (buyPressureRatio > 1.25 && upCount >= 6) signals.push("Buying Pressure");
        if (isRsiRisingBull) signals.push("RSI Momentum");

        g.signals = signals;

        const rawScore = calcDetailedReversalScore({
          pct24h: g.pct24h,
          pct30d: g.pct30d,
          volUsd: g.volUsd,
          rsi: g.rsi,
          distFromBottom: g.distFromBottom,
          ema10Cross: g.ema10Cross,
          volIncreaseDaily: g.volIncreaseDaily,
          emaAligned1h: g.emaAligned1h,
          volRatio,
          freshEmaCross,
          freshEma50Breakout,
          wasOversold,
          aboveEma50,
          buyPressureRatio,
          isBullStructure,
          makingHigherLows,
          emaRibbonAlign,
          isRsiRisingBull
        });

        const prevScore = prevScores.get(g.coin);
        if (prevScore !== undefined) {
          g.score = Math.round(prevScore * 0.65 + rawScore * 0.35);
        } else {
          g.score = rawScore;
        }
      }
    } catch (e) {
      console.error(`[fetchTopRecoveries] error for ${g.coin}:`, e.message);
      g.rsi = 50;
      g.emaAligned1h = false;
      g.signals = [];
      g.score = 30;
    }
  }));

  // Best-to-buy ordering: score → 24h momentum → volume
  losers.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.pct24h !== a.pct24h) return b.pct24h - a.pct24h;
    return b.volUsd - a.volUsd;
  });
  return losers.slice(0, 10);
}

app.get('/api/top-recoveries', async (req, res) => {
  try {
    const now = Date.now();
    const force = req.query.force === 'true';
    if (!force && now - topRecoveriesCache.fetchedAt < TOP_RECOVERIES_TTL && topRecoveriesCache.data.length) {
      return res.json({ success: true, recoveries: topRecoveriesCache.data, fetchedAt: topRecoveriesCache.fetchedAt, cached: true });
    }
    const recoveries = await fetchTopRecoveries();
    topRecoveriesCache = { data: recoveries, fetchedAt: Date.now() };
    res.json({ success: true, recoveries, fetchedAt: topRecoveriesCache.fetchedAt, cached: false });
  } catch (e) {
    console.error('[top-recoveries]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== PREDICTOR API ==========

// Default watchlist for the Predictor scan
const PREDICTOR_WATCHLIST_FILE = path.join(__dirname, 'data', 'predictor', 'watchlist.json');
const DEFAULT_WATCHLIST = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'MATIC', 'DOT', 'NEAR', 'SUI', 'APT', 'INJ', 'ARB'];

function loadWatchlist() {
  try {
    if (fs.existsSync(PREDICTOR_WATCHLIST_FILE)) {
      return JSON.parse(fs.readFileSync(PREDICTOR_WATCHLIST_FILE, 'utf8'));
    }
  } catch {}
  return DEFAULT_WATCHLIST;
}
function saveWatchlist(list) {
  try { fs.writeFileSync(PREDICTOR_WATCHLIST_FILE, JSON.stringify(list, null, 2)); } catch {}
}

// In-memory state for the background scan
const predictorState = {
  scanning: false,
  scanProgress: 0,
  lastScanAt: 0,
  results: [],
  tf: '1h',
  trainQueue: new Set(),
};

async function runPredictorScan(tf = predictorState.tf) {
  if (predictorState.scanning) return;
  predictorState.scanning = true;
  predictorState.scanProgress = 0;
  predictorState.tf = tf;
  const list = loadWatchlist();
  console.log(`[PREDICTOR] Scan started for ${list.length} coins on ${tf}`);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const symbol = list[i];
    try {
      // Train model if missing — only first time per symbol/tf
      const k = `${symbol}_${tf}`;
      const cached = predictor.getCacheState().find(s => s.key === k);
      if (!cached || !cached.hasModel) {
        if (!predictorState.trainQueue.has(k)) {
          predictorState.trainQueue.add(k);
          predictor.trainSymbol(symbol, tf, { candleCount: 500, iterations: 150 })
            .then(r => console.log(`[PREDICTOR] Trained ${k}: loss=${r.loss.toFixed(3)}`))
            .catch(e => console.error(`[PREDICTOR] Train ${k} failed:`, e.message))
            .finally(() => predictorState.trainQueue.delete(k));
        }
      }
      const r = await predictor.predictSymbol(symbol, tf, { candleCount: 250 });
      if (!r.error) out.push(r);
    } catch (e) {
      console.error(`[PREDICTOR] ${symbol} ${tf}:`, e.message);
    }
    predictorState.scanProgress = Math.round((i + 1) / list.length * 100);
  }
  out.sort((a, b) => {
    const dirRank = d => d === 'BUY' ? 0 : d === 'SELL' ? 1 : 2;
    const ra = dirRank(a.signal.direction), rb = dirRank(b.signal.direction);
    if (ra !== rb) return ra - rb;
    return b.signal.confidence - a.signal.confidence;
  });
  predictorState.results = out;
  predictorState.lastScanAt = Date.now();
  predictorState.scanProgress = 100;
  predictorState.scanning = false;
  console.log(`[PREDICTOR] Scan complete: ${out.length} results`);
}

// NOTE: predictor watchlist scan runs only on explicit refresh trigger (no auto-scan).

// ── Full-market scan: every online USD pair on Coinbase, heuristic-only (no NN training) ──
const predictorAllState = {
  scanning: false,
  progress: 0,
  scanned: 0,
  total: 0,
  lastScanAt: 0,
  tf: '1h',
  results: [],
};

async function runPredictorAllScan(tf = '1h') {
  if (predictorAllState.scanning) return;
  predictorAllState.scanning = true;
  predictorAllState.progress = 0;
  predictorAllState.scanned = 0;
  predictorAllState.tf = tf;
  console.log(`[PREDICTOR-ALL] Scan started on ${tf}`);
  try {
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const pairs = products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency)
      .filter(s => !STABLECOINS.has(s));
    predictorAllState.total = pairs.length;

    const out = [];
    const BATCH = 2;
    for (let i = 0; i < pairs.length; i += BATCH) {
      const batch = pairs.slice(i, i + BATCH);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const r = await predictor.predictSymbol(symbol, tf, { candleCount: 200 });
          if (!r.error && r.signal) {
            const vol24h = cbVolumeCache.get(symbol) || 0;
            out.push({
              symbol, tf,
              direction: r.signal.direction,
              probability: r.signal.probability,
              confidence: r.signal.confidence,
              heuristic: r.signal.heuristic,
              price: r.signal.price,
              stop: r.signal.stop,
              tp: r.signal.tp,
              riskReward: r.signal.riskReward,
              rsi: r.indicators.rsi14,
              atr: r.indicators.atr14,
              volume24h: vol24h,
            });
          }
        } catch {}
      }));
      predictorAllState.scanned += batch.length;
      predictorAllState.progress = Math.round(predictorAllState.scanned / pairs.length * 100);
      await sleep(700);
    }

    out.sort((a, b) => {
      const dirRank = d => d === 'BUY' ? 0 : d === 'SELL' ? 1 : 2;
      const ra = dirRank(a.direction), rb = dirRank(b.direction);
      if (ra !== rb) return ra - rb;
      return b.confidence - a.confidence;
    });
    predictorAllState.results = out;
    predictorAllState.lastScanAt = Date.now();
    console.log(`[PREDICTOR-ALL] Scan complete: ${out.length} coins, ${out.filter(x=>x.direction!=='HOLD').length} signals`);
  } catch (e) {
    console.error('[PREDICTOR-ALL] error:', e.message);
  } finally {
    predictorAllState.scanning = false;
    predictorAllState.progress = 100;
  }
}

// NOTE: predictor "scan all coins" runs only on explicit refresh trigger (no auto-scan).

app.get('/api/predictor/scan-all', (req, res) => {
  if (req.query.refresh === '1' && !predictorAllState.scanning) {
    runPredictorAllScan(req.query.tf || predictorAllState.tf).catch(() => {});
  }
  const minVol = parseFloat(req.query.minVol) || 0;
  const dirFilter = (req.query.dir || '').toUpperCase();
  let results = predictorAllState.results;
  if (minVol > 0) results = results.filter(r => r.volume24h >= minVol);
  if (dirFilter && ['BUY', 'SELL', 'HOLD'].includes(dirFilter)) {
    results = results.filter(r => r.direction === dirFilter);
  }
  res.json({
    success: true,
    scanning: predictorAllState.scanning,
    progress: predictorAllState.progress,
    scanned: predictorAllState.scanned,
    total: predictorAllState.total,
    lastScanAgo: predictorAllState.lastScanAt ? Math.round((Date.now() - predictorAllState.lastScanAt) / 1000) : null,
    tf: predictorAllState.tf,
    results,
  });
});

// ── Moonshots scanner: recovery pattern + technical confirmation across all Coinbase USD pairs ──
const moonshotsLib = require('./src/predictor/moonshots');
const MOONSHOTS_MODES = ['swing', 'quick', 'intra', 'scalp'];
const moonshotsState = {
  swing: { scanning: false, progress: 0, scanned: 0, total: 0, lastScanAt: 0, results: [] },
  quick: { scanning: false, progress: 0, scanned: 0, total: 0, lastScanAt: 0, results: [] },
  intra: { scanning: false, progress: 0, scanned: 0, total: 0, lastScanAt: 0, results: [] },
  scalp: { scanning: false, progress: 0, scanned: 0, total: 0, lastScanAt: 0, results: [] },
};

// ── Persistent storage for scan results so survives server restart ──
const MOONSHOTS_DATA_DIR = path.join(__dirname, 'data', 'moonshots');
function ensureMoonshotsDir() {
  if (!fs.existsSync(MOONSHOTS_DATA_DIR)) fs.mkdirSync(MOONSHOTS_DATA_DIR, { recursive: true });
}
ensureMoonshotsDir();

function moonScanFile(mode) {
  return path.join(MOONSHOTS_DATA_DIR, `scan-${mode}.json`);
}

function loadMoonScanFromDisk(mode) {
  try {
    const f = moonScanFile(mode);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`[MOONSHOTS:${mode}] load error:`, e.message);
    return null;
  }
}
function saveMoonScanToDisk(mode, payload) {
  try {
    fs.writeFileSync(moonScanFile(mode), JSON.stringify(payload));
  } catch (e) {
    console.error(`[MOONSHOTS:${mode}] save error:`, e.message);
  }
}

// Load any previously saved scans on startup so devices see the same data
MOONSHOTS_MODES.forEach(m => {
  const saved = loadMoonScanFromDisk(m);
  if (saved && Array.isArray(saved.results)) {
    moonshotsState[m].results = saved.results;
    moonshotsState[m].lastScanAt = saved.lastScanAt || 0;
    console.log(`[MOONSHOTS:${m}] loaded ${saved.results.length} cached results from disk`);
  }
});

// ── Paper positions storage — shared across all devices via the server ──
const PAPER_POSITIONS_FILE = path.join(MOONSHOTS_DATA_DIR, 'paper-positions.json');
function loadPaperPositions() {
  try {
    if (fs.existsSync(PAPER_POSITIONS_FILE)) return JSON.parse(fs.readFileSync(PAPER_POSITIONS_FILE, 'utf8'));
  } catch (e) {
    console.error('[PAPER] load error:', e.message);
  }
  return {};
}
function savePaperPositions(positions) {
  try {
    fs.writeFileSync(PAPER_POSITIONS_FILE, JSON.stringify(positions, null, 2));
  } catch (e) {
    console.error('[PAPER] save error:', e.message);
  }
}

app.get('/api/moonshots/positions', (req, res) => {
  res.json({ success: true, positions: loadPaperPositions() });
});

app.post('/api/moonshots/positions', (req, res) => {
  try {
    const { coin, buyPrice, buySizeUsd, feePct } = req.body;
    if (!coin || !buyPrice || !buySizeUsd) {
      return res.status(400).json({ success: false, error: 'Missing required fields: coin, buyPrice, buySizeUsd' });
    }
    const positions = loadPaperPositions();
    if (positions[coin]) {
      return res.json({ success: false, error: `${coin} already in portfolio`, position: positions[coin] });
    }
    positions[coin] = {
      coin,
      buyPrice: parseFloat(buyPrice),
      buySizeUsd: parseFloat(buySizeUsd),
      feePct: parseFloat(feePct) || 0.075,
      buyAt: Date.now(),
    };
    savePaperPositions(positions);
    res.json({ success: true, position: positions[coin] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/moonshots/positions/:coin', (req, res) => {
  const positions = loadPaperPositions();
  const coin = req.params.coin;
  if (!positions[coin]) return res.json({ success: false, error: 'Not found' });
  delete positions[coin];
  savePaperPositions(positions);
  res.json({ success: true });
});

app.delete('/api/moonshots/positions', (req, res) => {
  savePaperPositions({});
  res.json({ success: true });
});

async function runMoonshotsScan(mode = 'swing') {
  const st = moonshotsState[mode];
  if (!st || st.scanning) return;
  st.scanning = true;
  st.progress = 0;
  st.scanned = 0;
  console.log(`[MOONSHOTS:${mode}] Scan started`);
  try {
    const cbRes = await fetch('https://api.exchange.coinbase.com/products');
    const products = await cbRes.json();
    const pairs = products
      .filter(p => p.quote_currency === 'USD' && p.status === 'online')
      .map(p => p.base_currency)
      .filter(s => !STABLECOINS.has(s));
    st.total = pairs.length;

    const out = await moonshotsLib.scanAll(pairs, cbVolumeCache, (done, total) => {
      st.scanned = done;
      st.progress = Math.round(done / total * 100);
    }, mode);
    st.results = out;
    st.lastScanAt = Date.now();
    // Persist to disk so all devices see the same data after a server restart
    saveMoonScanToDisk(mode, { results: out, lastScanAt: st.lastScanAt });
    console.log(`[MOONSHOTS:${mode}] Scan complete: ${out.length} candidates (saved to disk)`);
  } catch (e) {
    console.error(`[MOONSHOTS:${mode}] error:`, e.message);
  } finally {
    st.scanning = false;
    st.progress = 100;
  }
}

// NOTE: no automatic moonshots scans. Scans run only when the user clicks Refresh
// (which hits /api/moonshots/scan-all). The server starts with empty caches
// and waits for an explicit trigger.

// Fire all scans concurrently — single "Refresh" button on the UI hits this.
app.get('/api/moonshots/scan-all', (req, res) => {
  MOONSHOTS_MODES.forEach(m => {
    if (!moonshotsState[m].scanning) {
      runMoonshotsScan(m).catch(e => console.error(`[MOONSHOTS:${m}] scan-all:`, e.message));
    }
  });
  const status = {};
  MOONSHOTS_MODES.forEach(m => {
    status[m] = { scanning: moonshotsState[m].scanning, progress: moonshotsState[m].progress };
  });
  res.json({
    success: true,
    triggered: MOONSHOTS_MODES.filter(m => moonshotsState[m].scanning),
    status,
  });
});

// Combined freshness across all 4 modes — used by the UI so the Last-Scan
// indicator stays consistent when you switch between modes.
function buildGlobalScanStatus() {
  const anyScanning = MOONSHOTS_MODES.some(m => moonshotsState[m].scanning);
  // "Earliest of last-scan times" = how stale is the freshest snapshot the
  // user is looking at. We use the MINIMUM lastScanAt across modes that have
  // any data, so a single mode falling behind doesn't show as fresh.
  let earliest = null;
  MOONSHOTS_MODES.forEach(m => {
    const t = moonshotsState[m].lastScanAt;
    if (t > 0 && (earliest == null || t < earliest)) earliest = t;
  });
  // Totals across modes for the in-progress indicator
  let totalScanned = 0, totalTotal = 0;
  MOONSHOTS_MODES.forEach(m => {
    totalScanned += moonshotsState[m].scanned;
    totalTotal += moonshotsState[m].total;
  });
  return {
    anyScanning,
    earliestScanAt: earliest,
    earliestScanAgo: earliest ? Math.round((Date.now() - earliest) / 1000) : null,
    scanned: totalScanned,
    total: totalTotal,
    progress: totalTotal ? Math.round(totalScanned / totalTotal * 100) : 0,
    perMode: Object.fromEntries(MOONSHOTS_MODES.map(m => [
      m,
      {
        scanning: moonshotsState[m].scanning,
        progress: moonshotsState[m].progress,
        lastScanAgo: moonshotsState[m].lastScanAt ? Math.round((Date.now() - moonshotsState[m].lastScanAt) / 1000) : null,
      },
    ])),
  };
}

app.get('/api/moonshots/scan', (req, res) => {
  const requested = req.query.mode;
  const mode = MOONSHOTS_MODES.includes(requested) ? requested : 'swing';
  const st = moonshotsState[mode];
  if (req.query.refresh === '1' && !st.scanning) {
    runMoonshotsScan(mode).catch(() => {});
  }
  const minVol = parseFloat(req.query.minVol) || 0;
  const minScore = parseFloat(req.query.minScore) || 0;
  const freshOnly = req.query.fresh === '1';
  let results = st.results;
  if (minVol > 0) results = results.filter(r => r.volume24h >= minVol);
  if (minScore > 0) results = results.filter(r => r.score >= minScore);
  if (freshOnly) {
    if (mode === 'scalp') {
      results = results.filter(r => r.minutesFromBottom != null && r.minutesFromBottom <= 30);
    } else if (mode === 'intra') {
      results = results.filter(r => r.hoursFromBottom != null && r.hoursFromBottom <= 2);
    } else if (mode === 'quick') {
      results = results.filter(r => r.hoursFromBottom != null && r.hoursFromBottom <= 6);
    } else {
      results = results.filter(r => r.daysFromBottom != null && r.daysFromBottom <= 7);
    }
  }
  res.json({
    success: true,
    mode,
    scanning: st.scanning,
    progress: st.progress,
    scanned: st.scanned,
    total: st.total,
    lastScanAgo: st.lastScanAt ? Math.round((Date.now() - st.lastScanAt) / 1000) : null,
    results,
    global: buildGlobalScanStatus(),
  });
});

// API: get current scan results + status
app.get('/api/predictor/scan', (req, res) => {
  if (req.query.refresh === '1' && !predictorState.scanning) {
    runPredictorScan(req.query.tf || predictorState.tf).catch(() => {});
  }
  res.json({
    success: true,
    scanning: predictorState.scanning,
    scanProgress: predictorState.scanProgress,
    lastScanAgo: predictorState.lastScanAt ? Math.round((Date.now() - predictorState.lastScanAt) / 1000) : null,
    tf: predictorState.tf,
    watchlist: loadWatchlist(),
    results: predictorState.results,
    cache: predictor.getCacheState(),
  });
});

// API: predict a single symbol on demand
app.get('/api/predictor/predict', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    const tf = req.query.tf || '1h';
    const candleCount = parseInt(req.query.candles, 10) || 250;
    const r = await predictor.predictSymbol(symbol, tf, { candleCount });
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: train (or retrain) a single symbol
app.post('/api/predictor/train', async (req, res) => {
  try {
    const symbol = (req.body.symbol || 'BTC').toUpperCase();
    const tf = req.body.tf || '1h';
    const candleCount = parseInt(req.body.candles, 10) || 500;
    const iterations = parseInt(req.body.iterations, 10) || 200;
    const r = await predictor.trainSymbol(symbol, tf, { candleCount, iterations });
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: backtest a symbol
app.post('/api/predictor/backtest', async (req, res) => {
  try {
    const symbol = (req.body.symbol || 'BTC').toUpperCase();
    const tf = req.body.tf || '1h';
    const candleCount = parseInt(req.body.candles, 10) || 500;
    const r = await predictor.backtestSymbol(symbol, tf, {
      candleCount,
      confidenceThreshold: parseFloat(req.body.threshold) || 0.6,
      atrMultiplier: parseFloat(req.body.atrMult) || 1.5,
      iterations: parseInt(req.body.iterations, 10) || 150,
    });
    res.json({ success: true, result: r });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: signal history
app.get('/api/predictor/signals', (req, res) => {
  const all = predictor.storage.loadSignals();
  const limit = parseInt(req.query.limit, 10) || 50;
  res.json({ success: true, signals: all.slice(0, limit) });
});

// API: watchlist management
app.get('/api/predictor/watchlist', (req, res) => {
  res.json({ success: true, watchlist: loadWatchlist() });
});
app.post('/api/predictor/watchlist', (req, res) => {
  try {
    const list = (req.body.watchlist || []).map(s => String(s).toUpperCase().trim()).filter(Boolean);
    saveWatchlist(list);
    res.json({ success: true, watchlist: list });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: 30-day trading volume — paginates the Coinbase fills endpoint until we hit
// 30 days back, then sums quote-side USD value across all sides.
let volume30dCache = { data: null, ts: 0 };
const VOLUME_30D_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/get-volume-30d', async (req, res) => {
  try {
    const now = Date.now();
    if (volume30dCache.data && (now - volume30dCache.ts) < VOLUME_30D_TTL) {
      return res.json({ success: true, ...volume30dCache.data, cached: true });
    }
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let cursor = undefined;
    let totalUsd = 0;
    let totalFees = 0;
    let buyUsd = 0, sellUsd = 0;
    let buyCount = 0, sellCount = 0;
    let pages = 0;
    let oldestSeen = null;

    while (pages < 50) { // hard safety cap
      const params = { limit: 250, start_sequence_timestamp: cutoff.toISOString() };
      if (cursor) params.cursor = cursor;
      const result = await client.listFills(params);
      const data = typeof result === 'string' ? JSON.parse(result) : result;
      const fills = data.fills || [];
      for (const f of fills) {
        const ts = new Date(f.trade_time);
        if (ts < cutoff) continue;
        const size = parseFloat(f.size || 0);
        const price = parseFloat(f.price || 0);
        const fee = parseFloat(f.commission || 0);
        const usd = size * price;
        totalUsd += usd;
        totalFees += fee;
        if (f.side === 'BUY') { buyUsd += usd; buyCount++; }
        else if (f.side === 'SELL') { sellUsd += usd; sellCount++; }
        if (!oldestSeen || ts < oldestSeen) oldestSeen = ts;
      }
      pages++;
      if (!data.cursor || fills.length === 0) break;
      cursor = data.cursor;
      // Stop early if we've already reached older than cutoff
      if (oldestSeen && oldestSeen < cutoff) break;
    }

    const out = {
      totalUsd: Math.round(totalUsd * 100) / 100,
      totalFees: Math.round(totalFees * 100) / 100,
      buyUsd: Math.round(buyUsd * 100) / 100,
      sellUsd: Math.round(sellUsd * 100) / 100,
      buyCount, sellCount,
      totalFills: buyCount + sellCount,
      pages,
    };
    volume30dCache = { data: out, ts: now };
    res.json({ success: true, ...out });
  } catch (e) {
    console.error('Error computing 30d volume:', e.message);
    if (volume30dCache.data) return res.json({ success: true, ...volume30dCache.data, stale: true });
    res.status(500).json({ success: false, error: e.message });
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
