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

// Kill any existing process on our port before starting
const { execSync } = require('child_process');
const isWindows = process.platform === 'win32';
try {
  if (isWindows) {
    const result = execSync(`cmd /c "netstat -ano | findstr :${PORT} | findstr LISTENING"`, { encoding: 'utf8', timeout: 5000, shell: true });
    const pids = new Set();
    result.trim().split('\n').forEach(line => {
      const pid = parseInt(line.trim().split(/\s+/).pop());
      if (pid && pid !== process.pid) pids.add(pid);
    });
    pids.forEach(pid => {
      try { execSync(`cmd /c "taskkill /F /PID ${pid}"`, { encoding: 'utf8', timeout: 5000, shell: true });
        console.log(`[STARTUP] Killed stale process on port ${PORT} (PID: ${pid})`);
      } catch {}
    });
    if (pids.size > 0) {
      // Wait for port to be released
      const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
      wait(2000);
    }
  } else {
    const result = execSync(`lsof -ti:${PORT} 2>/dev/null || true`, { encoding: 'utf8', timeout: 5000 });
    result.trim().split('\n').filter(Boolean).forEach(pid => {
      const p = parseInt(pid);
      if (p && p !== process.pid) {
        try { execSync(`kill -9 ${p}`, { timeout: 5000 });
          console.log(`[STARTUP] Killed stale process on port ${PORT} (PID: ${p})`);
        } catch {}
      }
    });
  }
} catch (e) { /* no process on port - good */ }

function startServer(retries = 5) {
  server = app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });

  // Keep-alive and timeout settings to prevent hanging connections
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // Handle server errors (e.g. EADDRINUSE)
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      if (retries > 0) {
        console.error(`[ERROR] Port ${PORT} in use. Retrying in 3s... (${retries} attempts left)`);
        // Try to kill the process holding the port
        try {
          if (isWindows) {
            const result = execSync(`cmd /c "netstat -ano | findstr :${PORT} | findstr LISTENING"`, { encoding: 'utf8', timeout: 5000, shell: true });
            result.trim().split('\n').forEach(line => {
              const pid = parseInt(line.trim().split(/\s+/).pop());
              if (pid && pid !== process.pid) {
                try { execSync(`cmd /c "taskkill /F /PID ${pid}"`, { timeout: 5000, shell: true }); } catch {}
              }
            });
          } else {
            execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`, { timeout: 5000 });
          }
        } catch {}
        setTimeout(() => startServer(retries - 1), 3000);
      } else {
        console.error(`[ERROR] Port ${PORT} still in use after retries. Exiting.`);
        process.exit(1);
      }
    } else {
      console.error('[ERROR] Server error:', err);
    }
  });
}

startServer();
