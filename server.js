require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
// Приложение живёт на Kamatera и открывается с телефона и с ноутбука по
// 103.90.162.77:3847. Значение по умолчанию 127.0.0.1 сделало бы его
// недоступным сразу после деплоя: переменной HOST в .env на сервере нет,
// а поставить её туда отсюда нельзя — SSH нет, только /api/deploy.
// Кто хочет слушать только себя, ставит HOST=127.0.0.1 явно.
const HOST = process.env.HOST || '0.0.0.0';
const TRUSTED_ORIGINS = new Set(
  String(process.env.TRUSTED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const APP_API_TOKEN = String(process.env.APP_API_TOKEN || '');
const DEPLOY_KEY = String(process.env.DEPLOY_KEY || '');

function constantTimeTokenEquals(provided, expected) {
  if (!expected || typeof provided !== 'string') return false;
  const actualBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

const publicDir = path.join(__dirname, 'public');
const settingsFile = path.join(__dirname, 'settings.json');
const profitFile = path.join(__dirname, 'profit-history.json');
const favoritesFile = path.join(__dirname, 'favorites.json');

// CryptoRank API
const CRYPTORANK_API_KEY = process.env.CRYPTORANK_API_KEY;
const CRYPTORANK_BASE_URL = 'https://api.cryptorank.io/v2';

// Default settings
const defaultSettings = {
  sellMarkup: 1.38,    // % увеличения продажи
  tradeFee: 0.125,     // % комиссии limit ордера
  marketFee: 0.25    // % комиссии market ордера
};

// Load/Save settings
function publicSettings(settings) {
  const { telegramToken, telegramChat, ...safeSettings } = settings || {};
  // Сам токен наружу не отдаём, но отдаём факт его наличия. Иначе ни
  // интерфейс, ни проверки не могут отличить «Telegram настроен» от
  // «настройка потерялась при деплое», а алерты молчат одинаково в обоих
  // случаях — ровно та немая поломка, которую мы уже однажды ловили.
  safeSettings.telegramConfigured = !!(
    (process.env.TELEGRAM_BOT_TOKEN || telegramToken) &&
    (process.env.TELEGRAM_CHAT_ID || telegramChat)
  );
  return safeSettings;
}

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
// Only the same site (or explicitly configured origins) may call mutation APIs.
function isTrustedOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  const host = req.get('host');
  return origin === 'http://' + host || origin === 'https://' + host || TRUSTED_ORIGINS.has(origin);
}

app.use((req, res, next) => {
  const origin = req.get('origin');
  const trusted = isTrustedOrigin(req);
  if (origin && trusted) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-App-Token, X-Deploy-Key');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return trusted ? res.sendStatus(204) : res.sendStatus(403);
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (isMutation && req.path !== '/api/deploy') {
    if (!trusted) return res.status(403).json({ success: false, error: 'Origin is not allowed' });
    if (APP_API_TOKEN && !constantTimeTokenEquals(req.get('x-app-token'), APP_API_TOKEN)) {
      return res.status(401).json({ success: false, authRequired: true, error: 'App token is required' });
    }
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
app.use(express.json({ limit: '100kb' }));

const SPOT_USD_PRODUCT_RE = /^[A-Z0-9]{2,20}-USD$/;
function normalizeSpotUsdProduct(value) {
  const productId = String(value || '').trim().toUpperCase();
  return SPOT_USD_PRODUCT_RE.test(productId) ? productId : null;
}
function isPositiveFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}
function hasValidOrderId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(value);
}
function invalidOrderInput(res, error) {
  return res.status(400).json({ success: false, error });
}

// API: Get settings
app.get('/get-settings', (req, res) => {
  res.json({ success: true, settings: publicSettings(loadSettings()) });
});

// API: Save settings
app.post('/save-settings', (req, res) => {
  try {
    const { sellMarkup, tradeFee, marketFee, bidLevel, telegramToken, telegramChat } = req.body;
    const prev = loadSettings();
    // merge: перезаписываем только присланные поля — чтобы клиент с неполным набором не затирал остальное
    const settings = {
      sellMarkup: sellMarkup !== undefined ? (parseFloat(sellMarkup) || defaultSettings.sellMarkup) : (prev.sellMarkup ?? defaultSettings.sellMarkup),
      tradeFee: tradeFee !== undefined ? (parseFloat(tradeFee) || defaultSettings.tradeFee) : (prev.tradeFee ?? defaultSettings.tradeFee),
      marketFee: marketFee !== undefined ? (parseFloat(marketFee) || defaultSettings.marketFee) : (prev.marketFee ?? defaultSettings.marketFee),
      bidLevel: bidLevel !== undefined ? Math.min(0, Math.max(-20, parseInt(bidLevel, 10) || 0)) : (prev.bidLevel || 0),
      telegramToken: telegramToken !== undefined ? String(telegramToken).trim() : (prev.telegramToken || ''),
      telegramChat: telegramChat !== undefined ? String(telegramChat).trim() : (prev.telegramChat || '')
    };
    saveSettings(settings);
    res.json({ success: true, settings: publicSettings(settings) });
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
// Выбранная монета. Жила только в localStorage, причём под разными ключами
// на десктопе и на мобильной, поэтому не синхронизировалась и терялась при
// очистке кэша — а сбросившийся к BTC выбор рядом с кнопками продажи это не
// косметика.
const selectedCoinFile = path.join(__dirname, 'selected-coin.json');
app.get('/api/selected-coin', (req, res) => {
  try {
    const d = fs.existsSync(selectedCoinFile) ? JSON.parse(fs.readFileSync(selectedCoinFile, 'utf8')) : {};
    res.json({ success: true, coin: d.coin || null, at: d.at || null });
  } catch { res.json({ success: true, coin: null, at: null }); }
});

app.post('/api/selected-coin', (req, res) => {
  try {
    const raw = String((req.body || {}).coin || '').trim().toUpperCase();
    // Тикеры Coinbase — латиница, цифры и дефис. Мусор в этот файл не пишем.
    if (!/^[A-Z0-9-]{1,15}$/.test(raw)) {
      return res.json({ success: false, error: 'Некорректный тикер' });
    }
    fs.writeFileSync(selectedCoinFile, JSON.stringify({ coin: raw, at: Date.now() }));
    res.json({ success: true, coin: raw });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/favorites', (req, res) => {
  try {
    const coins = fs.existsSync(favoritesFile) ? JSON.parse(fs.readFileSync(favoritesFile, 'utf8')) : [];
    res.json({ success: true, coins });
  } catch { res.json({ success: true, coins: [] }); }
});

app.post('/api/favorites', (req, res) => {
  try {
    const coins = Array.isArray(req.body.coins) ? req.body.coins : [];
    fs.writeFileSync(favoritesFile, JSON.stringify(coins));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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

// API: Рыночная продажа всей позиции.
// placeMarketSell уже был, но только для внутреннего аварийного стопа
// авто-выхода. Здесь он же выставлен наружу под кнопку.
app.post('/api/market-sell', async (req, res) => {
  try {
    const { productId, size } = req.body || {};
    const product = normalizeSpotUsdProduct(productId);
    const sz = Number(size);
    if (!product || !isPositiveFiniteNumber(sz)) {
      return invalidOrderInput(res, 'A valid USD product and positive size are required');
    }
    // Сверяем с реальным остатком: продать больше, чем есть, нельзя, а
    // расхождение обычно значит, что часть уже продана в другой вкладке.
    let available = null;
    try {
      const coin = product.split('-')[0];
      const accounts = [];
      let cursor;
      do {
        const params = { limit: 250 };
        if (cursor) params.cursor = cursor;
        const result = await client.listAccounts(params);
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        accounts.push(...(data.accounts || []));
        cursor = data.has_next ? data.cursor : null;
      } while (cursor);
      const acc = accounts.find(a => a.currency === coin);
      available = acc ? parseFloat(acc.available_balance?.value || 0) : null;
      if (available != null && sz > available * 1.0001) {
        return res.json({
          success: false,
          error: `На балансе ${available} ${coin}, продать ${sz} нельзя. Обнови страницу.`,
        });
      }
    } catch (e) {
      // Сверку не удалось выполнить — это не повод отказывать: биржа всё
      // равно отклонит ордер сверх остатка. Но в логе должно остаться.
      console.warn('[market-sell] баланс не сверен:', e.message);
    }
    console.log('Creating MARKET sell:', product, sz);
    const orderId = await placeMarketSell(product, sz);
    if (!orderId) return res.json({ success: false, error: 'Биржа не вернула id ордера' });
    console.log('Market sell created, ID:', orderId);
    ordersCache.ts = 0; // сбрасываем кеш: иначе список ордеров ещё 8с без продажи
    balanceCache.ts = 0;
    res.json({ success: true, orderId });
  } catch (error) {
    console.error('Market sell error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create limit sell order
app.post('/create-sell-order', async (req, res) => {
  try {
    const { productId, size, price } = req.body || {};
    const product = normalizeSpotUsdProduct(productId);
    const sellSize = Number(size);
    const limitPrice = Number(price);
    if (!product || !isPositiveFiniteNumber(sellSize) || !isPositiveFiniteNumber(limitPrice)) {
      return invalidOrderInput(res, 'A valid USD product, size and limit price are required');
    }
    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const orderData = {
      client_order_id: clientOrderId,
      product_id: product,
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
      const prodRes = await fetch(`https://api.exchange.coinbase.com/products/${product}`);
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
    orderData.order_configuration.limit_limit_gtc.limit_price = limitPrice.toFixed(quoteDecimals);
    orderData.order_configuration.limit_limit_gtc.base_size = sellSize.toFixed(baseDecimals);

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
    const { orderId } = req.body || {};
    if (!hasValidOrderId(orderId)) {
      return invalidOrderInput(res, 'A valid order ID is required');
    }
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

// API: Рыночная покупка на сумму в долларах.
// Отдельный эндпоинт, а не флаг у лимитного: market_market_ioc для BUY
// принимает quote_size (сумму), тогда как лимитный считает base_size из цены.
// Смешивать их в одной ветке — верный способ однажды купить не то количество.
app.post('/create-market-buy-order', async (req, res) => {
  try {
    const { productId, quoteSize } = req.body || {};
    const product = normalizeSpotUsdProduct(productId);
    const usd = Number(quoteSize);
    if (!product || !isPositiveFiniteNumber(usd)) {
      return invalidOrderInput(res, 'A valid USD product and positive amount are required');
    }
    // Потолок на случай опечатки в поле суммы: рыночный ордер исполняется
    // мгновенно и отменить его нельзя.
    if (usd > 10000) {
      return res.json({ success: false, error: `Сумма $${usd} выше потолка $10000 для рыночной покупки` });
    }
    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const orderData = {
      client_order_id: clientOrderId,
      product_id: product,
      side: 'BUY',
      order_configuration: { market_market_ioc: { quote_size: usd.toFixed(2) } },
    };
    console.log('Creating MARKET buy order:', orderData);
    const response = await client.createOrder(orderData);
    const parsed = typeof response === 'string' ? JSON.parse(response) : response;

    if (parsed.success === false || parsed.error_response) {
      const errorMsg = parsed.error_response?.message || parsed.error_response?.error
        || parsed.error_response?.preview_failure_reason || 'Order rejected';
      console.error('Coinbase rejected market buy:', errorMsg);
      return res.json({ success: false, error: errorMsg, details: parsed });
    }
    const orderId = parsed.success_response?.order_id || parsed.order_id;
    if (!orderId) {
      console.error('No order ID in market buy response:', parsed);
      return res.json({ success: false, error: 'No order ID returned', details: parsed });
    }
    console.log('Market buy created, ID:', orderId);
    ordersCache.ts = 0;
    balanceCache.ts = 0;
    res.json({ success: true, orderId });
  } catch (error) {
    console.error('Market buy error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: Create limit buy order
app.post('/create-buy-order', async (req, res) => {
  try {
    const { productId, quoteSize, limitPrice, orderType, stopPrice } = req.body || {};
    const product = normalizeSpotUsdProduct(productId);
    const price = Number(limitPrice);
    const usdAmount = Number(quoteSize);
    const stopVal = stopPrice === undefined || stopPrice === null || stopPrice === '' ? price : Number(stopPrice);
    if (!product || !isPositiveFiniteNumber(price) || !isPositiveFiniteNumber(usdAmount) || (orderType === 'stop_limit' && !isPositiveFiniteNumber(stopVal))) {
      return invalidOrderInput(res, 'A valid USD product, amount and limit price are required');
    }
    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    // Fetch product info to get correct precision (base_increment & quote_increment)
    let baseDecimals = 8, quoteDecimals = 2;
    try {
      const prodRes = await fetch(`https://api.exchange.coinbase.com/products/${product}`);
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
      const stopPriceStr = stopVal.toFixed(quoteDecimals);
      orderData = {
        client_order_id: clientOrderId,
        product_id: product,
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
        product_id: product,
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
    // fresh=1 обходит кеш. Нужен сразу после сделки: биржа досыпает в ордер
    // filled_size, total_value и комиссию не мгновенно, и восьмисекундный кеш
    // успевал заморозить полупустой снимок на два цикла опроса.
    const fresh = req.query.fresh === '1';
    if (!fresh && ordersCache.data && (now - ordersCache.ts) < ORDERS_CACHE_TTL) {
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
      // Время ПОСЛЕДНЕГО исполнения. У лимитки она может провисеть сутки:
      // created_time скажет, когда её выставили, а не когда продалось.
      last_fill_time: order.last_fill_time || null,
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
  if (!CRYPTORANK_API_KEY) throw new Error('CryptoRank API key is not configured');
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
const STABLECOINS = new Set(['USDT','USDC','DAI','BUSD','TUSD','GUSD','USDP','FRAX','LUSD','CRVUSD','PYUSD','EURC','FDUSD','USDS','USDM','ALUSD','SUSD','MUSD','DOLA','RAI','EUR','GBP','CBETH']);

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
// ОТКЛЮЧЕНО: панель удалена из интерфейса, автоскан жёг лимит Coinbase впустую. setTimeout(runResearchScan, 20000);
// ОТКЛЮЧЕНО: панель удалена из интерфейса, автоскан жёг лимит Coinbase впустую. setInterval(runResearchScan, 30 * 60 * 1000);

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
// ОТКЛЮЧЕНО: панель удалена из интерфейса, автоскан жёг лимит Coinbase впустую. setTimeout(runRecoveryScan, 15000);
// Re-scan every 30 minutes
// ОТКЛЮЧЕНО: панель удалена из интерфейса, автоскан жёг лимит Coinbase впустую. setInterval(runRecoveryScan, 30 * 60 * 1000);

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
// ОТКЛЮЧЕНО: панель удалена из интерфейса, автоскан жёг лимит Coinbase впустую. setTimeout(runDipScan, 45000);
// ОТКЛЮЧЕНО: панель удалена из интерфейса, автоскан жёг лимит Coinbase впустую. setInterval(runDipScan, 15 * 60 * 1000);

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

// ══════════ TOP LOSERS 30d (mcap ≥ $30M, торгуются на Coinbase) ══════════
let topLosersCache = { data: [], fullAt: 0, priceAt: 0 };
let topLosersBuilding = false;
// Прогресс пересборки: 0-80% — сбор списка, 80-90% — свинг, 90-100% — скальп
let tlProgress = { pct: 0, phase: '' };
let mcapCache = { map: {}, at: 0 };
// Кеш на диске — после рестарта таблица доступна сразу, без ожидания первой сборки
const TOP_LOSERS_FILE = path.join(__dirname, 'top-losers-cache.json');
try {
  const saved = JSON.parse(fs.readFileSync(TOP_LOSERS_FILE, 'utf8'));
  if (saved.data && saved.data.length) topLosersCache = saved;
  if (saved.mcap && Object.keys(saved.mcap.map || {}).length) mcapCache = saved.mcap;
  console.log(`[top-losers] loaded ${topLosersCache.data.length} coins from disk cache`);
} catch { }
function saveTopLosersCache() {
  try { fs.writeFileSync(TOP_LOSERS_FILE, JSON.stringify({ ...topLosersCache, mcap: mcapCache })); } catch { }
}

async function getMcapMap() {
  if (Date.now() - mcapCache.at < 60 * 60 * 1000 && Object.keys(mcapCache.map).length) return mcapCache.map;
  try {
    const data = await cryptorankFetch('/currencies', { limit: 1000, sortBy: 'rank', sortDirection: 'ASC' });
    const map = {};
    (data.data || []).forEach(c => {
      const sym = (c.symbol || '').toUpperCase();
      const mc = parseFloat(c.marketCap ?? c.values?.USD?.marketCap ?? 0);
      const px = parseFloat(c.price ?? c.values?.USD?.price ?? 0);
      if (sym && mc && !map[sym]) map[sym] = { mc, px }; // px нужен для проверки коллизий тикеров
    });
    if (Object.keys(map).length) mcapCache = { map, at: Date.now() };
  } catch (e) {
    // CryptoRank отдаёт 401 при исчерпании лимита ключа. Раньше это роняло
    // всю пересборку, и список молча устаревал. Работаем на прошлой карте:
    // капитализации меняются медленно, для фильтра mcap ≥ $30M этого хватает.
    const have = Object.keys(mcapCache.map).length;
    if (!have) throw e;
    const ageMin = Math.round((Date.now() - mcapCache.at) / 60000);
    console.warn(`[mcap] ${e.message} — работаю на кэше (${have} монет, возраст ${ageMin} мин)`);
  }
  return mcapCache.map;
}

// Рейтинг отскока (0-10) + вердикт: покупать ли упавшую монету СЕЙЧАС.
// Логика: дно позади → рост подтверждён → RSI вышел из перепроданности → ликвидность ок → есть микро-откат для входа.
function calcReboundVerdict(c) {
  // Нет базы (старый кеш без low30/daysLow) — честно не считаем, вместо мусорного вердикта
  if (!(c.low30 > 0) || c.daysLow == null) { c.rb = null; c.rbTag = ''; c.rbInfo = null; return; }
  const bounce = c.low30 > 0 ? (c.price - c.low30) / c.low30 * 100 : 0;       // отскок от 30д минимума
  const pullback = c.hi5 > 0 ? (c.hi5 - c.price) / c.hi5 * 100 : 0;           // откат от 5-дневного хая
  const volR = c.mcap > 0 ? (c.vol24 || 0) / c.mcap : 0;                       // объём/капитализация
  let rb = 3;
  if (c.daysLow >= 2 && bounce > 3)      rb += 2;   // дно позади, отскок держится
  else if (c.daysLow >= 1 && bounce > 1) rb += 1;
  else if (c.daysLow === 0)              rb -= 2;   // сегодня новое дно — падающий нож
  if (c.upDays >= 2) rb += 1;                        // растёт 2+ дня подряд
  if (c.upDays >= 4) rb += 0.5;
  if (c.rsiD != null) {
    if (c.rsiD >= 30 && c.rsiD <= 50) rb += 1.5;    // вышел из перепроданности, не перегрет
    else if (c.rsiD < 25)             rb -= 1;      // ещё в яме
    else if (c.rsiD > 60)             rb -= 0.5;    // отскок уже перегрет
  }
  if (volR >= 0.02)       rb += 1;                   // живой объём ≥2% капы
  else if (volR < 0.005)  rb -= 2;                   // мёртвый оборот
  if (bounce > 3 && pullback >= 1 && pullback <= 5) rb += 1.5; // идеальный вход: разворот + небольшой откат
  else if (pullback > 8)                             rb -= 1;  // откат слишком глубокий — разворот под вопросом
  rb = Math.max(0, Math.min(10, Math.round(rb * 2) / 2));
  let tag;
  if ((c.vol24 || 0) < 100_000 || volR < 0.003) tag = 'НЕЛИКВИД';
  else if (c.daysLow === 0 || bounce < 1)       tag = 'ПАДАЕТ';
  else if (rb >= 7 && pullback >= 1)            tag = 'ПОКУПАТЬ';
  else if (rb >= 7)                             tag = 'ЖДАТЬ ОТКАТ';
  else if (rb >= 5)                             tag = 'СЛЕДИТЬ';
  else                                          tag = 'РАНО';
  c.rb = rb; c.rbTag = tag;
  c.rbInfo = { bounce: Math.round(bounce * 10) / 10, pullback: Math.round(pullback * 10) / 10, daysLow: c.daysLow, upDays: c.upDays, rsiD: c.rsiD != null ? Math.round(c.rsiD) : null, volR: Math.round(volR * 1000) / 10 };
}

async function rebuildTopLosers() {
  if (topLosersBuilding) return;
  topLosersBuilding = true;
  try {
    const CB = 'https://api.exchange.coinbase.com';
    const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
    const mcap = await getMcapMap();
    const prodRes = await fetch(`${CB}/products`, H);
    const products = await prodRes.json();
    const pairs = (Array.isArray(products) ? products : [])
      .filter(p => p.quote_currency === 'USD' && p.status === 'online' && !p.trading_disabled)
      .map(p => p.id);
    const cands = pairs.filter(id => (mcap[id.replace('-USD', '')]?.mc || 0) >= 30_000_000);
    const out = [];
    const now = Date.now();
    const start = new Date(now - 32 * 86400 * 1000).toISOString();
    const end = new Date(now).toISOString();
    // при сбое запроса не теряем монету — берём прошлую запись из кэша
    const keepOld = (sym) => {
      const old = topLosersCache.data.find(x => x.coin === sym);
      if (old) out.push(old);
    };
    // Прогресс по трём фазам: список занимает основное время, оценки — хвост
    let doneCands = 0;
    for (const id of cands) {
      const sym = id.replace('-USD', '');
      doneCands++;
      tlProgress = { pct: Math.round(doneCands / cands.length * 80), phase: 'список' };
      try {
        const r = await fetch(`${CB}/products/${id}/candles?granularity=86400&start=${start}&end=${end}`, H);
        if (!r.ok) { keepOld(sym); continue; }
        const cd = await r.json();
        if (!Array.isArray(cd) || cd.length < 20) continue;
        cd.sort((a, b) => a[0] - b[0]);
        const first = cd[0][4], last = cd[cd.length - 1][4];
        if (!first || !last) continue;
        // Коллизия тикеров: если цена Cryptorank отличается от Coinbase в разы — это другой проект, mcap чужой
        const crPx = mcap[sym]?.px;
        if (crPx > 0 && (last / crPx > 2.5 || crPx / last > 2.5)) continue;
        // Объём: сперва общий кеш (он собирается с /stats — честный rolling 24h).
        // Иначе — ПРЕДЫДУЩАЯ полная дневная свеча. Текущую брать нельзя: в начале
        // UTC-суток в ней доля оборота, и монета ложно выглядит неликвидной.
        const prevDay = cd.length >= 2 ? cd[cd.length - 2] : null;
        const vol24 = cbVolumeCache.get(sym) || (prevDay ? (prevDay[5] || 0) * last : (cd[cd.length - 1][5] || 0) * last);
        // База для рейтинга отскока
        const closesD = cd.map(x => x[4]), lowsD = cd.map(x => x[1]);
        let loIdx = 0;
        for (let i = 0; i < lowsD.length; i++) if (lowsD[i] < lowsD[loIdx]) loIdx = i;
        let upDays = 0;
        for (let i = closesD.length - 1; i > 0 && closesD[i] >= closesD[i - 1]; i--) upDays++;
        const entry = {
          coin: sym, pair: id, price: last, pct30d: (last - first) / first * 100, mcap: mcap[sym].mc, vol24,
          low30: lowsD[loIdx], daysLow: closesD.length - 1 - loIdx, hi5: Math.max(...closesD.slice(-5)), upDays,
          rsiD: calcRSIsrv(closesD, 14),
          spark: cd.map(x => Math.round(x[4] * 1e8) / 1e8)
        };
        calcReboundVerdict(entry);
        // Переносим оценки из прошлого кэша, чтобы таблица не была пустой,
        // пока идёт свежий расчёт. Они перезапишутся через несколько секунд.
        const prevEntry = topLosersCache.data.find(x => x.coin === sym);
        if (prevEntry) {
          if (prevEntry.rvSig) entry.rvSig = prevEntry.rvSig;
          if (prevEntry.rv) entry.rv = prevEntry.rv;
          if (prevEntry.sc) entry.sc = prevEntry.sc;
        }
        out.push(entry);
      } catch { keepOld(sym); }
      await new Promise(r2 => setTimeout(r2, 120));
    }
    out.sort((a, b) => a.pct30d - b.pct30d);
    // При 429 на /products Coinbase отдаёт объект вместо массива, кандидатов
    // не остаётся, и раньше пустой результат затирал кэш — таблица пропадала
    // и не восстанавливалась после рестарта. Пустую сборку не принимаем.
    if (!out.length) {
      console.warn('[top-losers] пересборка вернула 0 монет — оставляю прошлый кэш');
      return;
    }
    topLosersCache = { data: out.slice(0, 20), fullAt: Date.now(), priceAt: Date.now() };
    saveTopLosersCache();
    console.log(`[top-losers] rebuilt: ${cands.length} candidates (mcap≥30M), top20 saved`);
    // Reversal Score считаем после сборки списка — нужны часовые свечи по каждой монете
    tlProgress = { pct: 80, phase: 'свинг' };
    try { await attachReversal(topLosersCache.data); saveTopLosersCache(); } catch (e) { console.error('[reversal]', e.message); }
    // Скальп сразу следом — иначе после пересборки колонка пустует до своего интервала
    tlProgress = { pct: 90, phase: 'скальп' };
    try { await attachScalp(); } catch (e) { console.error('[scalp]', e.message); }
    tlProgress = { pct: 100, phase: '' };
  } catch (e) { console.error('[top-losers]', e.message); }
  finally { topLosersBuilding = false; }
}

let refreshingPrices = false;
async function refreshTopLosersPrices(force) {
  if (!topLosersCache.data.length) return;
  if (!force && Date.now() - topLosersCache.priceAt <= 30_000) return;
  // Вызывается из четырёх мест (API, buy-watch, paperBotTick, attachReversal).
  // Без этой защиты параллельные проходы множили поток тикеров и ловили 429.
  if (refreshingPrices) return;
  refreshingPrices = true;
  // Запоминаем объект кэша: rebuildTopLosers может заменить его целиком, пока
  // мы ждём биржу, и тогда цены легли бы в выброшенный массив, а свежим
  // пометился бы новый — цены замирали до следующего force.
  const cacheRef = topLosersCache;
  const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
  // Пачка из 20 одновременных тикеров ловила 429, и объём оставался чёрновым
  // из дневной свечи → монеты ложно уезжали в НЕЛИКВИД. Идём партиями с ретраем.
  const list = cacheRef.data;
  let volOk = 0;
  try {
  for (let i = 0; i < list.length; i += 5) {
    await Promise.all(list.slice(i, i + 5).map(async c => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(`https://api.exchange.coinbase.com/products/${c.pair}/ticker`, H);
          if (r.status === 429) { await sleep(400 * (attempt + 1)); continue; }
          if (!r.ok) return;
          const t = await r.json();
          const px = parseFloat(t.price || t.ask || t.bid);
          if (!(px > 0)) return;
          const base = c.price / (1 + c.pct30d / 100); // цена месяц назад
          c.price = px;
          c.pct30d = base > 0 ? (px - base) / base * 100 : c.pct30d;
          const bv = parseFloat(t.volume); // rolling 24h объём в монетах
          if (bv > 0) { c.vol24 = bv * px; c.volAt = Date.now(); volOk++; }
          calcReboundVerdict(c); // рейтинг отскока живёт вместе с ценой
          recomputeReversal(c);  // и REV тоже — на свежих цене и объёме
          return;
        } catch { return; }
      }
    }));
    if (i + 5 < list.length) await sleep(120);
  }
    if (volOk < list.length) console.log(`[top-losers] объём обновлён у ${volOk}/${list.length} (остальные — из общего кеша объёмов)`);
    // Штампуем тот же кэш, который обновляли: если пересборка успела его
    // заменить, помечать свежим новый было бы ложью
    cacheRef.data.sort((a, b) => a.pct30d - b.pct30d);
    cacheRef.priceAt = Date.now();
  } finally { refreshingPrices = false; }
}

app.get('/api/top-losers', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    if ((force || !topLosersCache.data.length) && !topLosersBuilding) rebuildTopLosers(); // пересборка в фоне
    await refreshTopLosersPrices(force);
    res.json({
      success: true, coins: topLosersCache.data, updatedAt: topLosersCache.priceAt, rebuiltAt: topLosersCache.fullAt,
      rebuilding: topLosersBuilding, building: topLosersBuilding && !topLosersCache.data.length,
      rebuildPct: tlProgress.pct, rebuildPhase: tlProgress.phase,
      buyWatch: buyWatchArmed, scalpWatch: scalpWatchArmed,
      paperBudget: paperBot.budgetUsd,
      paperOpen: paperBot.open.map(p => ({
        id: p.id, coin: p.coin, pair: p.pair, entry: p.entry, last: p.last, sl: p.sl, slStage: p.slStage,
        openedAt: p.openedAt, budget: p.budget, source: p.source || 'auto',
        qty: p.qty, feePct: p.feePct, targetPct: p.targetPct, target: paperTargetPrice(p),
        pnl: p.last ? paperPnl(p, p.last) : null,
        pnlPct: p.last ? Math.round(paperPnl(p, p.last) / p.budget * 10000) / 100 : null
      })),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Вотч «появился ПОКУПАТЬ» в Top Losers → Telegram, одноразовый ──
const BUY_WATCH_FILE = path.join(__dirname, 'buy-watch.json');
let buyWatchArmed = false;
try { buyWatchArmed = !!(JSON.parse(fs.readFileSync(BUY_WATCH_FILE, 'utf8')).armed); } catch { }
function saveBuyWatch() { try { fs.writeFileSync(BUY_WATCH_FILE, JSON.stringify({ armed: buyWatchArmed })); } catch { } }

app.post('/api/buy-watch', (req, res) => {
  const enable = !!(req.body || {}).enable;
  if (enable) {
    const s = loadSettings();
    if (!(s.telegramToken && s.telegramChat)) return res.json({ success: false, error: 'Telegram не настроен: укажи Bot Token и Chat ID в настройках' });
  }
  buyWatchArmed = enable;
  saveBuyWatch();
  res.json({ success: true, armed: buyWatchArmed });
});

// Чекер раз в 60с: сервер сам следит, даже когда все браузеры закрыты.
// Единственный источник Telegram-сообщений по Top Losers — эта кнопка.
// Ищем монету, прошедшую откалиброванный reversal-гейт (4/4); если reversal
// ещё не посчитан — откатываемся на старый вердикт ПОКУПАТЬ.
setInterval(async () => {
  if (!buyWatchArmed || !topLosersCache.data.length) return;
  try {
    await refreshTopLosersPrices(false);
    // Работаем по REV. Откат на старый вердикт — ТОЛЬКО если reversal вообще ещё
    // не посчитан (свежий рестарт). Если он посчитан и входов нет — просто ждём
    // дальше, а не подсовываем старый сигнал: гейт проходит ~23 раза в месяц по
    // всему рынку, иначе алерт улетал бы почти сразу и мимо цели.
    const revReady = topLosersCache.data.some(c => c.rv);
    const revHits = topLosersCache.data.filter(c => c.rv && c.rv.pass);
    const byRev = revReady;
    const pool = revReady ? revHits : topLosersCache.data.filter(c => c.rbTag === 'ПОКУПАТЬ');
    if (!pool.length) return;
    const c = byRev
      ? pool.sort((a, b) => (b.rv.score || 0) - (a.rv.score || 0))[0]
      : pool.sort((a, b) => (b.rb || 0) - (a.rb || 0))[0];
    const ri = c.rbInfo || {};
    const text = byRev
      ? `🎯 <b>REVERSAL ВХОД</b> — <b>${c.pair}</b>\n` +
        `Рейтинг <b>${c.rv.score}/100</b> · гейт 4/4\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        c.rv.checks.map(x => `✅ ${x.k}: ${x.v}`).join('\n') + '\n' +
        `💵 Цена: $${fmtPxAe(c.price)}\n` +
        `📉 30d: ${c.pct30d.toFixed(1)}%\n\n` +
        `<i>Гейт откалиброван бэктестом: 44% побед, PF 1.34 (база 37%).\n` +
        `Ожидание ≈ +0.27% на сделку — входи лимиткой, не по рынку.</i>\n` +
        `(одноразовый алерт — выключен)`
      : `🟢 <b>BUY SIGNAL — Top Losers rebound</b>\n` +
        `<b>${c.pair}</b> — рейтинг <b>${c.rb}/10</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📉 30d: ${c.pct30d.toFixed(1)}%\n` +
        `🔄 Отскок от дна: +${ri.bounce}% (дно ${ri.daysLow} дн назад)\n` +
        `📊 Дневной RSI: ${ri.rsiD} · откат от 5д хая: ${ri.pullback}%\n` +
        `💵 Цена: $${fmtPxAe(c.price)}\n` +
        `<i>(reversal-гейт ещё не посчитан — сработал старый вердикт)</i>\n` +
        `(одноразовый алерт — выключен)`;
    const sent = await sendTelegram(text, 'HTML');
    if (!sent) {
      console.error('[buy-watch] ' + c.pair + ': отправка не удалась, алерт остаётся включённым');
      return;
    }
    buyWatchArmed = false;
    saveBuyWatch();
    console.log(`[buy-watch] сработал: ${c.pair} ${byRev ? 'rv=' + c.rv.score : 'rb=' + c.rb}, telegram=${sent}`);
  } catch (e) { console.error('[buy-watch]', e.message); }
}, 60_000);
setInterval(rebuildTopLosers, 10 * 60 * 1000);
setTimeout(rebuildTopLosers, 30_000);

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

const trendCache = {};
const TREND_TTL = 5 * 60 * 1000;

async function fetchTrendData(coin) {
  const now = Date.now();
  if (trendCache[coin] && now - trendCache[coin].ts < TREND_TTL) {
    return trendCache[coin].data;
  }
  try {
    const CB = 'https://api.exchange.coinbase.com';
    const end = new Date(now);
    const start = new Date(now - 10 * 3600 * 1000);
    const url = `${CB}/products/${coin}-USD/candles?granularity=3600&start=${start.toISOString()}&end=${end.toISOString()}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'trading-app/1.0' } });
    if (!r.ok) return null;
    const candles = await r.json();
    if (!Array.isArray(candles) || candles.length < 4) return null;
    candles.sort((a, b) => a[0] - b[0]);
    const closes = candles.map(c => c[4]);
    const cur = closes[closes.length - 1];
    const h1 = closes[closes.length - 2];
    const h4 = closes.length >= 5 ? closes[closes.length - 5] : null;
    const pct1h = h1 ? (cur - h1) / h1 * 100 : null;
    const pct4h = h4 ? (cur - h4) / h4 * 100 : null;
    // Recovery: falling last 4h but last hour turned positive
    const recovering = pct4h !== null && pct4h < -1.5 && pct1h !== null && pct1h > 0.3;
    const data = { pct1h, pct4h, recovering };
    trendCache[coin] = { data, ts: now };
    return data;
  } catch { return null; }
}

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
        const volUsd = parseFloat(s.volume) * last;
        if (!last || !volUsd) return null;
        const pct24h = open ? (last - open) / open * 100 : 0;
        return { coin: id.replace('-USD', ''), price: last, pct24h, volUsd };
      } catch { return null; }
    }));
    results.push(...stats.filter(Boolean));
    if (i + BATCH < usdPairs.length) await new Promise(r => setTimeout(r, 80));
  }
  results.sort((a, b) => b.volUsd - a.volUsd);
  const top20 = results.filter(c => c.volUsd >= 5_000_000).slice(0, 20);

  // Fetch trend data (hourly candles) in parallel
  const trends = await Promise.all(top20.map(c => fetchTrendData(c.coin)));
  top20.forEach((c, i) => {
    const t = trends[i];
    c.pct1h = t?.pct1h ?? null;
    c.pct4h = t?.pct4h ?? null;
    c.recovering = t?.recovering ?? false;
  });

  return top20;
}

const depthCache = {};
const DEPTH_TTL = 30_000;

async function fetchCoinDepth(coin, midPrice) {
  const CB = 'https://api.exchange.coinbase.com';
  // level=2 returns top 50 aggregated price levels — fast and covers 2% range
  const r = await fetch(`${CB}/products/${coin}-USD/book?level=2`, {
    headers: { 'User-Agent': 'trading-app/1.0' }
  });
  if (!r.ok) {
    console.warn(`[depth] ${coin} HTTP ${r.status}`);
    return { buy: 0, sell: 0 };
  }
  const book = await r.json();
  if (!Array.isArray(book.bids) || !book.bids.length) {
    console.warn(`[depth] ${coin} no bids in response`);
    return { buy: 0, sell: 0 };
  }
  const lowBound = midPrice * 0.98, highBound = midPrice * 1.02;
  let buy = 0, sell = 0;
  for (const e of book.bids) { const p = parseFloat(e[0]), s = parseFloat(e[1]); if (p >= lowBound) buy += p * s; }
  for (const e of book.asks) { const p = parseFloat(e[0]), s = parseFloat(e[1]); if (p <= highBound) sell += p * s; }
  return { buy, sell };
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

// ══════════ Server-side Score engine ══════════
// Считает скор по всем монетам каждые 10 минут 24/7, копит историю снапшотов
// и оценивает точность: дошла ли цена до +2% раньше, чем до −2%.
const SCORE_HIST_FILE = path.join(__dirname, 'score-history.json');
let scoreHist = [];
try { scoreHist = JSON.parse(fs.readFileSync(SCORE_HIST_FILE, 'utf8')); } catch { }
// Дедупликация при старте: убираем снапшоты чаще 8 мин на монету (артефакт рестарт-циклов)
{
  const lastByCoin = {};
  scoreHist = scoreHist.filter(s => {
    const prev = lastByCoin[s.c];
    if (prev != null && s.t - prev < 8 * 60 * 1000) return false;
    lastByCoin[s.c] = s.t;
    return true;
  });
}
let latestScores = {};

function saveScoreHist() {
  try { fs.writeFileSync(SCORE_HIST_FILE, JSON.stringify(scoreHist.slice(-5000))); }
  catch (e) { console.error('[score] save', e.message); }
}

function calcRSIsrv(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) g += d; else l -= d; }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function calcEMAsrv(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

// Зеркало клиентского calcCoinScore (v5) — при изменении клиента менять и тут
function scoreFromMetrics(d, isBTC, btcPct1h) {
  let score = 5;
  const parts = [];
  const add = (v, label) => { v = Math.round(v * 10) / 10; if (v) { score += v; parts.push(`${label}: ${v > 0 ? '+' : ''}${v}`); } };
  const lerp = (x, x0, y0, x1, y1) => y0 + (y1 - y0) * Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  const rising = d.pct1h != null && (d.pct1h > 0 || d.recovering);
  if (d.pct1h != null) {
    const vol = Math.max(d.avgRange || 0.5, 0.15);
    add(Math.max(-2.2, Math.min(2.2, d.pct1h / vol * 1.1)), '1h импульс');
    if (d.pct1h > 3) add(-lerp(d.pct1h, 3, 0, 10, 2), 'погоня за пампом');
  }
  if (d.recovering) {
    let v = 0.8;
    if (d.fallingHours >= 4) v += 0.4;
    if (d.totalFallPct != null && d.totalFallPct < -3) v += 0.4;
    if (d.totalFallPct != null && d.totalFallPct < -6) v += 0.4;
    add(v, 'разворот');
  }
  if (d.rsi != null) {
    if (d.rsi < 50)      add(lerp(d.rsi, 25, 2, 50, 0), 'RSI');
    else if (d.rsi > 60) add(-lerp(d.rsi, 60, 0, 80, 2), 'RSI');
  }
  if (d.rsi != null && d.pct1h != null) {
    if (d.rsi < 45 && rising)      add(1, 'RSI+тренд');
    if (d.rsi > 65 && d.pct1h < 0) add(-1, 'RSI+тренд');
  }
  if (d.volRatio != null) {
    if (d.volRatio > 1.3)      add(Math.min(1, (d.volRatio - 1.3) / 1.2) * (rising ? 1 : -1), 'объём');
    else if (d.volRatio < 0.5) add(-0.3, 'объём');
  }
  if (d.priceVsEma != null) {
    if      (d.priceVsEma > 0 && d.emaRising)  add(1, 'EMA20');
    else if (d.priceVsEma > 0 && !d.emaRising) add(0.2, 'EMA20');
    else if (d.priceVsEma < 0 && d.emaRising)  add(0.5, 'EMA20');
    else if (d.priceVsEma < 0 && !d.emaRising) add(-1, 'EMA20');
  }
  if (d.emaCross != null) add(d.emaCross > 0 ? 0.5 : -0.5, 'EMA крест');
  if (d.pct24h != null) {
    if (d.pct24h < -2)     add(lerp(-d.pct24h, 2, 0.2, 8, 0.7), '24h дип');
    else if (d.pct24h > 5) add(-lerp(d.pct24h, 5, 0.5, 30, 3), '24h перегрев');
    if (d.pct24h > 60)     add(-1.5, 'экстрим-памп'); // калибровка v2: 29% побед
  }
  if (d.riseHours != null && d.riseHours >= 5) {
    const sevR = d.avgRange ? d.totalRisePct / Math.max(d.avgRange, 0.2) : null;
    if (d.riseHours >= 8 || (sevR != null && sevR > 6)) add(-1.2, 'усталость роста');
    else add(-0.6, 'усталость роста');
  }
  if (d.pct40h != null) {
    if (d.pct40h > 20)      add(-1, 'перегрев 40h');
    else if (d.pct40h > 12) add(-0.5, 'перегрев 40h');
  }
  if (d.priceVsEma != null) {
    if (d.priceVsEma > 4)        add(-1, 'оторвана от EMA');
    else if (d.priceVsEma > 2.5) add(-0.5, 'оторвана от EMA');
  }
  if (d.rangePos != null) {
    if (d.rangePos < 0.25)     add(rising ? 1 : 0.3, 'у дна 24h');
    else if (d.rangePos > 0.9) add((d.volRatio > 2 && rising) ? 0.5 : -0.2, d.volRatio > 2 && rising ? 'пробой хая' : 'у хая 24h');
  }
  if (d.greenCount6 != null) {
    if (d.greenCount6 >= 4 && rising)       add(0.4, 'стабильный рост');
    else if (d.greenCount6 <= 1 && !rising) add(-0.5, 'слабая структура');
  }
  if (d.avgRange != null) {
    if      (d.avgRange < 0.25) add(-0.5, 'низкая волат.');
    else if (d.avgRange > 1)    add(0.3, 'волатильность');
  }
  if (d.hlStreak >= 3) add(0.5, 'higher lows');
  const totalDepth = (d.bidDepth || 0) + (d.askDepth || 0);
  if (totalDepth > 0) {
    if (totalDepth < 30000)       add(-1.8, 'тонкий стакан'); // калибровка v2: 38% побед
    else if (totalDepth < 100000) add(-0.7, 'тонкий стакан');
  }
  if (d.bidDepth > 0 && d.askDepth > 0) {
    const ratio = d.bidDepth / d.askDepth;
    if      (ratio > 2)    add(1, 'стакан');
    else if (ratio > 1.5)  add(0.5, 'стакан');
    else if (ratio < 0.5)  add(-1, 'стакан');
    else if (ratio < 0.67) add(-0.5, 'стакан');
  }
  if (d.pct15m != null) {
    if (rising && d.green15 >= 3)       add(0.5, '15m подтверждает');
    else if (rising && d.pct15m < -0.3) add(-0.5, '15m против');
    else if (!rising && d.green15 >= 3 && d.pct15m > 0.1 && (d.dd15 == null || d.dd15 < 1.5)) add(0.7, '15m ранний разворот');
  }
  if (d.dd15 != null) {
    const vol15 = Math.max(d.avgRange || 0.5, 0.3);
    const sev = d.dd15 / vol15;
    if      (sev > 4 || d.dd15 > 4)     add(-2.5, '15m обвал');
    else if (sev > 2.5 || d.dd15 > 2.5) add(-1.5, '15m обвал');
    else if (d.dd15 > 1.2)              add(-0.6, '15m просадка');
  }
  if (d.spreadPct != null) {
    if (d.spreadPct > 0.5)      add(-1.3, 'широкий спред'); // калибровка v2: 31% побед
    else if (d.spreadPct > 0.2) add(-0.6, 'спред');
  }
  if (!isBTC && btcPct1h != null) {
    if (btcPct1h < -0.5)     add(-0.7, 'BTC падает');
    else if (btcPct1h > 0.3) add(0.1, 'BTC растёт');
  }
  if (d.runwayPct != null) {
    if (d.runwayPct < 1)       add(-0.5, 'сопротивление рядом'); // калибровка v2: смягчено
    else if (d.runwayPct < 2)  add(-0.2, 'сопротивление');
  } else if (d.rangePos != null) add(0.1, 'нет сопротивления');
  if (d.macdRising != null) {
    if      (d.macdPos && d.macdRising)   add(0.5, 'MACD');
    else if (!d.macdPos && d.macdRising)  add(0.4, 'MACD разворот'); // калибровка v2: 94% побед
    else if (!d.macdPos && !d.macdRising) add(-0.5, 'MACD');
    else                                  add(-0.2, 'MACD слабеет');
  }
  if (d.bullEngulf && (d.fallingHours >= 2 || (d.rangePos != null && d.rangePos < 0.35))) add(0.4, 'бычье поглощение');
  if (d.nearBidDepth > 0 && d.nearAskDepth > 0) {
    const rN = d.nearBidDepth / d.nearAskDepth;
    if      (rN > 1.5)  add(0.5, 'стакан у цены');
    else if (rN < 0.67) add(-0.5, 'стакан у цены');
  }
  if (d.supportPct != null) {
    if (d.supportPct < 0.7)    add(0.4, 'поддержка рядом');
    else if (d.supportPct > 4) add(-0.4, 'пусто под ценой');
  }
  if (d.vsVwap != null) {
    if (d.vsVwap < -1 && rising)     add(0.6, 'ниже VWAP');
    else if (d.vsVwap < 0 && rising) add(0.3, 'ниже VWAP');
    else if (d.vsVwap > 2.5)         add(-0.8, 'дорого к VWAP'); // калибровка v2: 44% побед
  }
  if (d.tapeRatio != null) {
    if (d.tapeRatio > 1.8)       add(0.4, 'покупатели в ленте');
    else if (d.tapeRatio > 1.3)  add(0.2, 'покупатели в ленте');
    else if (d.tapeRatio < 0.55) add(-0.6, 'продавцы в ленте');
    else if (d.tapeRatio < 0.77) add(-0.3, 'продавцы в ленте');
  }
  return { score: Math.max(0, Math.min(10, Math.round(score * 2) / 2)), parts };
}

async function computeCoinMetrics(coin, price, pct24h) {
  const CB = 'https://api.exchange.coinbase.com';
  const H = { headers: { 'User-Agent': 'trading-app/1.0' } };
  const now = Date.now();
  const end = new Date(now).toISOString();
  const [r1, r15] = await Promise.all([
    fetch(`${CB}/products/${coin}-USD/candles?granularity=3600&start=${new Date(now - 40 * 3600 * 1000).toISOString()}&end=${end}`, H),
    fetch(`${CB}/products/${coin}-USD/candles?granularity=900&start=${new Date(now - 6 * 3600 * 1000).toISOString()}&end=${end}`, H)
  ]);
  if (!r1.ok) return null;
  const candles = await r1.json();
  if (!Array.isArray(candles) || candles.length < 3) return null;
  candles.sort((a, b) => a[0] - b[0]);
  const closes = candles.map(x => x[4]);
  const n = closes.length;
  const pct1h = closes[n-2] ? (closes[n-1] - closes[n-2]) / closes[n-2] * 100 : null;
  let fallingHours = 0;
  for (let i = n - 2; i > 0; i--) { if (closes[i] <= closes[i-1]) fallingHours++; else break; }
  const fallStart = n - 1 - fallingHours;
  const totalFallPct = fallStart >= 0 && closes[fallStart] ? (closes[n-2] - closes[fallStart]) / closes[fallStart] * 100 : 0;
  const recovering = fallingHours >= 2 && pct1h > 0.2;
  const workCloses = closes.slice(0, -1);
  const rsi = calcRSIsrv(workCloses, 14);
  const ema20 = calcEMAsrv(workCloses, 20);
  const ema20prev = workCloses.length > 21 ? calcEMAsrv(workCloses.slice(0, -1), 20) : null;
  const priceVsEma = ema20 ? (workCloses[workCloses.length - 1] - ema20) / ema20 * 100 : null;
  const emaRising = ema20 && ema20prev ? ema20 > ema20prev : null;
  const volumes = candles.map(x => x[5]);
  const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / Math.max(1, volumes.length - 1);
  const volRatio = avgVol > 0 ? volumes[n - 1] / avgVol : 1;
  const lows = candles.map(x => x[1]), highs = candles.map(x => x[2]);
  const lo24 = Math.min(...lows.slice(-24)), hi24 = Math.max(...highs.slice(-24));
  const rangePos = hi24 > lo24 ? (closes[n-1] - lo24) / (hi24 - lo24) : null;
  const ema9 = calcEMAsrv(workCloses, 9);
  const emaCross = ema9 != null && ema20 != null ? (ema9 > ema20 ? 1 : -1) : null;
  const rngs = candles.slice(-13, -1).map(x => x[1] > 0 ? (x[2] - x[1]) / x[1] * 100 : 0);
  const avgRange = rngs.length ? rngs.reduce((a, b) => a + b, 0) / rngs.length : null;
  let hlStreak = 0;
  for (let i = n - 2; i > 0 && lows[i] > lows[i-1]; i--) hlStreak++;
  let greenCount6 = 0;
  for (let i = Math.max(1, n - 7); i <= n - 2; i++) if (closes[i] > closes[i-1]) greenCount6++;
  // Усталость роста: сколько часов подряд растёт и на сколько всего
  let riseHours = 0;
  for (let i = n - 2; i > 0; i--) { if (closes[i] >= closes[i-1]) riseHours++; else break; }
  const riseStart = n - 1 - riseHours;
  const totalRisePct = riseStart >= 0 && closes[riseStart] ? (closes[n-2] - closes[riseStart]) / closes[riseStart] * 100 : 0;
  const pct40h = closes[0] ? (closes[n-1] - closes[0]) / closes[0] * 100 : null;
  const priceNow = closes[n-1];
  // Свинг-уровни с подтверждением 2 свечами с каждой стороны — иначе любой бугорок считался уровнем
  let resist = null;
  for (let i = 2; i < n - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] >= highs[i+1] && highs[i] >= highs[i+2] && highs[i] > priceNow) {
      if (resist === null || highs[i] < resist) resist = highs[i];
    }
  }
  const runwayPct = resist ? (resist - priceNow) / priceNow * 100 : null;
  // Поддержка: ближайший свинг-лоу ниже цены
  let support = null;
  for (let i = 2; i < n - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] <= lows[i+1] && lows[i] <= lows[i+2] && lows[i] < priceNow) {
      if (support === null || lows[i] > support) support = lows[i];
    }
  }
  const supportPct = support ? (priceNow - support) / priceNow * 100 : null;
  // VWAP за 24h
  let _pv = 0, _vv = 0;
  for (const k of candles.slice(-24)) { _pv += k[4] * k[5]; _vv += k[5]; }
  const vsVwap = _vv > 0 ? (priceNow - _pv / _vv) / (_pv / _vv) * 100 : null;
  const e12 = calcEMAsrv(workCloses, 12), e26 = calcEMAsrv(workCloses, 26);
  const pcl = workCloses.slice(0, -1);
  const e12p = calcEMAsrv(pcl, 12), e26p = calcEMAsrv(pcl, 26);
  const macdPos = e12 != null && e26 != null ? e12 - e26 > 0 : null;
  const macdRising = macdPos != null && e12p != null && e26p != null ? (e12 - e26) > (e12p - e26p) : null;
  const lastC = candles[n-2], prevC = candles[n-3];
  const bullEngulf = !!(lastC && prevC && lastC[4] > lastC[3] && prevC[4] < prevC[3] && lastC[4] >= prevC[3] && lastC[3] <= prevC[4]);
  // 15m: подтверждение и детектор обвала
  let pct15m = null, green15 = null, dd15 = null;
  try {
    if (r15.ok) {
      const c15 = await r15.json();
      if (Array.isArray(c15) && c15.length >= 3) {
        c15.sort((a, b) => a[0] - b[0]);
        const cl15 = c15.map(x => x[4]);
        const m = cl15.length;
        pct15m = cl15[m-2] ? (cl15[m-1] - cl15[m-2]) / cl15[m-2] * 100 : null;
        green15 = 0;
        for (let i = Math.max(1, m - 4); i <= m - 1; i++) if (cl15[i] > cl15[i-1]) green15++;
        const hi2h = Math.max(...c15.map(x => x[2]).slice(-9));
        dd15 = hi2h > 0 ? (hi2h - cl15[m-1]) / hi2h * 100 : null;
      }
    }
  } catch { }
  // Стакан: глубина ±2%, узкая зона ±0.5%, спред; лента сделок параллельно
  let bidDepth = 0, askDepth = 0, nearBidDepth = 0, nearAskDepth = 0, spreadPct = null, tapeRatio = null;
  const pTape = fetch(`${CB}/products/${coin}-USD/trades?limit=100`, H).then(x => x.ok ? x.json() : null).catch(() => null);
  try {
    const rb = await fetch(`${CB}/products/${coin}-USD/book?level=2`, H);
    if (rb.ok) {
      const book = await rb.json();
      const lo = price * 0.98, hi = price * 1.02, lo5 = price * 0.995, hi5 = price * 1.005;
      for (const e of (book.bids || [])) { const p = +e[0], s = +e[1]; if (p >= lo) bidDepth += p * s; if (p >= lo5) nearBidDepth += p * s; }
      for (const e of (book.asks || [])) { const p = +e[0], s = +e[1]; if (p <= hi) askDepth += p * s; if (p <= hi5) nearAskDepth += p * s; }
      const bb = +(((book.bids || [])[0] || [])[0]), ba = +(((book.asks || [])[0] || [])[0]);
      if (bb > 0 && ba > 0) spreadPct = (ba - bb) / ((ba + bb) / 2) * 100;
    }
  } catch { }
  // Агрессия в ленте: side = сторона мейкера, sell-мейкер значит агрессивный покупатель
  try {
    const tr = await pTape;
    if (Array.isArray(tr) && tr.length) {
      let bAg = 0, sAg = 0;
      for (const t of tr) { const v = parseFloat(t.size) * parseFloat(t.price); if (t.side === 'sell') bAg += v; else if (t.side === 'buy') sAg += v; }
      if (bAg || sAg) tapeRatio = sAg > 0 ? bAg / sAg : 5;
    }
  } catch { }
  return {
    d: { pct24h, pct1h, fallingHours, recovering, totalFallPct, rsi, priceVsEma, emaRising, volRatio, rangePos, emaCross, avgRange, hlStreak, greenCount6, runwayPct, macdPos, macdRising, bullEngulf, riseHours, totalRisePct, pct40h, supportPct, vsVwap, tapeRatio, pct15m, green15, dd15, bidDepth, askDepth, nearBidDepth, nearAskDepth, spreadPct },
    candles
  };
}

let scoreEngineRunning = false;
async function scoreEngineTick() {
  if (scoreEngineRunning) return;
  scoreEngineRunning = true;
  try {
    let coins = topVolumeCache.data;
    if (!coins.length || Date.now() - topVolumeCache.fetchedAt > TOP_VOLUME_TTL) {
      coins = await fetchTopVolume();
      topVolumeCache = { data: coins, fetchedAt: Date.now() };
    }
    coins = coins.filter(c => c.volUsd >= 5_000_000 && c.pct24h <= 100);
    // BTC первым — задаёт режим рынка для остальных
    coins = [...coins].sort((a, b) => (a.coin === 'BTC' ? -1 : 0) - (b.coin === 'BTC' ? -1 : 0));
    let btcPct1h = null;
    let changed = false;
    for (const c of coins) {
      try {
        const m = await computeCoinMetrics(c.coin, c.price, c.pct24h);
        if (!m) continue;
        if (c.coin === 'BTC') btcPct1h = m.d.pct1h;
        const { score, parts } = scoreFromMetrics(m.d, c.coin === 'BTC', btcPct1h);
        latestScores[c.coin] = { score, price: c.price, t: Date.now(), parts };
        // parts сохраняем в историю — для будущей калибровки весов по реальным исходам
        // (не чаще раза в 8 минут на монету — защита от спама при рестарт-циклах)
        const lastSnap = [...scoreHist].reverse().find(s => s.c === c.coin);
        if (!lastSnap || Date.now() - lastSnap.t > 8 * 60 * 1000) {
          // b = режим рынка (BTC 1h) на момент снапшота — для калибровки по режимам
          scoreHist.push({ c: c.coin, s: score, p: c.price, t: Date.now(), pt: parts, b: btcPct1h != null ? Math.round(btcPct1h * 10) / 10 : null });
          changed = true;
        }
        // Оценка прошлых снапшотов этой монеты по свежим свечам
        const nowMs = Date.now();
        for (const s of scoreHist) {
          if (s.c !== c.coin || s.r !== undefined) continue;
          if (nowMs - s.t < 30 * 60 * 1000) continue;
          let res, hitT = null;
          for (const k of m.candles) {
            if (k[0] * 1000 <= s.t) continue;
            const up = k[2] >= s.p * 1.02, dn = k[1] <= s.p * 0.98;
            if (up && !dn) { res = 1; hitT = k[0]; break; }
            if (dn) { res = 0; hitT = k[0]; break; }
          }
          if (res === undefined && nowMs - s.t > 24 * 3600 * 1000) res = 2; // таймаут: ни один уровень не достигнут — НЕ проигрыш
          if (res !== undefined) {
            s.r = res; s.v = 2; changed = true;                            // v:2 = трёхисходная схема
            if (hitT) s.h = Math.round((hitT * 1000 - s.t) / 360000) / 10; // реальное время до исхода, часов
          }
        }
      } catch (e) { console.error('[score]', c.coin, e.message); }
      await new Promise(r => setTimeout(r, 150));
    }
    if (changed) { scoreHist = scoreHist.slice(-5000); saveScoreHist(); }
    console.log(`[score] tick done: ${coins.length} coins, hist=${scoreHist.length}`);
  } catch (e) { console.error('[score] tick', e.message); }
  finally { scoreEngineRunning = false; }
}
setInterval(scoreEngineTick, 10 * 60 * 1000);
setTimeout(scoreEngineTick, 15_000); // первый прогон вскоре после старта

// ══════════ Telegram + алерт безубытка (Limit P&L → 0) ══════════
// Экранирование для parse_mode:HTML. Подписи условий гейта содержат «(<25%)»,
// и Telegram читал это как открывающий тег: ответ 400, сообщение НЕ уходило,
// а вызывающий код всё равно считал алерт отработавшим и снимал его. Так
// скальп-алерт молча не работал ни разу.
function escTg(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(text, parseMode) {
  const s = loadSettings();
  const token = process.env.TELEGRAM_BOT_TOKEN || s.telegramToken;
  const chat = process.env.TELEGRAM_CHAT_ID || s.telegramChat;
  if (!token || !chat) { console.error('[telegram] не настроен: нет token или chat'); return false; }
  const post = async (mode) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, ...(mode ? { parse_mode: mode } : {}) })
    });
    if (r.ok) return true;
    // Ответ Telegram раньше отбрасывался молча — именно поэтому причина
    // искалась вслепую. Теперь она в логе.
    let why = r.status;
    try { const j = await r.json(); why = r.status + ' ' + (j.description || ''); } catch { }
    console.error('[telegram] отказ (' + (mode || 'plain') + '): ' + why);
    return false;
  };
  try {
    if (await post(parseMode)) return true;
    // Разметка сломалась — отправляем без неё. Лучше кривое сообщение,
    // чем потерянный сигнал.
    if (parseMode) {
      const plain = await post(null);
      if (plain) console.error('[telegram] ушло без разметки');
      return plain;
    }
    return false;
  } catch (e) { console.error('[telegram]', e.message); return false; }
}

// ══════════ Telegram: уведомления об исполнении ордеров (100% filled) ══════════
const CLIENT_TELEGRAM_ALERT_KINDS = new Set(['tracked', 'checklist', 'scalp']);
app.post('/api/telegram/client-alert', async (req, res) => {
  const kind = String(req.body?.kind || '');
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!CLIENT_TELEGRAM_ALERT_KINDS.has(kind) || !text || text.length > 3500) {
    return res.status(400).json({ success: false, error: 'Invalid Telegram alert payload' });
  }
  const sent = await sendTelegram(text, kind === 'checklist' ? 'Markdown' : null);
  if (!sent) return res.status(502).json({ success: false, error: 'Telegram alert was not sent' });
  res.json({ success: true });
});
const NOTIFIED_FILE = path.join(__dirname, 'notified-fills.json');
let notifiedFills = [];
try { notifiedFills = JSON.parse(fs.readFileSync(NOTIFIED_FILE, 'utf8')); } catch { }
// baseline нужен только при самом первом запуске фичи (файла ещё нет).
// Если файл есть — продолжаем без баузлайна, иначе фили, случившиеся во время рестарта, глотаются молча.
let fillBaselineDone = notifiedFills.length > 0;

function fmtNumTg(n, d = 2) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPxTg(p) { p = parseFloat(p) || 0; return p < 0.001 ? p.toFixed(8) : p < 1 ? p.toFixed(6) : p < 100 ? p.toFixed(4) : p.toFixed(2); }

async function checkFilledOrders() {
  try {
    let orders;
    const now = Date.now();
    if (ordersCache.data && (now - ordersCache.ts) < ORDERS_CACHE_TTL) orders = ordersCache.data;
    else { orders = await getLatestOrders(); ordersCache = { data: orders, ts: now }; }
    const filled = orders.filter(o => o.status === 'FILLED');
    if (!fillBaselineDone) {
      // первый прогон после старта: существующие FILLED помечаем без уведомлений (не спамим историей)
      filled.forEach(o => { if (!notifiedFills.includes(o.order_id)) notifiedFills.push(o.order_id); });
      notifiedFills = notifiedFills.slice(-800);
      try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(notifiedFills)); } catch { }
      fillBaselineDone = true;
      return;
    }
    let changed = false;
    for (const o of filled) {
      if (notifiedFills.includes(o.order_id)) continue;
      const isBuy = o.side === 'BUY';
      const size = parseFloat(o.filled_size) || 0;
      const val = parseFloat(o.total_value) || 0;
      const fees = parseFloat(o.total_fees) || 0;
      const coin = (o.product_id || '').replace('-USD', '');
      const text =
        `${isBuy ? '🟢 <b>BUY FILLED</b>' : '🔴 <b>SELL FILLED</b>'} — <b>${o.product_id}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📦 Size: <b>${fmtNumTg(size, size < 1 ? 6 : 2)} ${coin}</b>\n` +
        `💵 Price: <b>$${fmtPxTg(o.average_filled_price)}</b>\n` +
        `💰 Total: <b>$${fmtNumTg(val)}</b>\n` +
        `🧾 Fee: $${fmtNumTg(fees)}\n` +
        `🕒 ${o.created_time ? new Date(o.created_time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'}`;
      const sent = await sendTelegram(text, 'HTML');
      notifiedFills.push(o.order_id);
      changed = true;
      console.log(`[fill-notify] ${o.product_id} ${o.side} filled, telegram=${sent}`);
      // Журнал сделок: фиксируем вход/выход с контекстом рынка на момент исполнения
      try { journalOnFill(o); } catch (e) { console.error('[journal] onFill', e.message); }
    }
    if (changed) {
      notifiedFills = notifiedFills.slice(-800);
      try { fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(notifiedFills)); } catch { }
    }
  } catch (e) { console.error('[fill-notify]', e.message); }
}
setInterval(checkFilledOrders, 30_000);
setTimeout(checkFilledOrders, 20_000); // baseline вскоре после старта

const BE_WATCH_FILE = path.join(__dirname, 'be-watches.json');
let beWatches = [];
try { beWatches = JSON.parse(fs.readFileSync(BE_WATCH_FILE, 'utf8')); } catch { }
function saveBeWatches() { try { fs.writeFileSync(BE_WATCH_FILE, JSON.stringify(beWatches)); } catch (e) { console.error('[be-watch] save', e.message); } }

app.get('/api/be-watch', (req, res) => res.json({ success: true, watches: beWatches }));

app.post('/api/be-watch', (req, res) => {
  const { coin, pair, filled, usd, enable } = req.body || {};
  if (!coin) return res.status(400).json({ success: false, error: 'no coin' });
  if (enable) {
    const s = loadSettings();
    if (!(s.telegramToken && s.telegramChat)) return res.json({ success: false, error: 'Telegram не настроен: укажи Bot Token и Chat ID в настройках' });
    beWatches = beWatches.filter(w => w.coin !== coin);
    beWatches.push({ coin, pair: pair || coin + '-USD', filled: parseFloat(filled) || 0, usd: parseFloat(usd) || 0, t: Date.now() });
  } else {
    beWatches = beWatches.filter(w => w.coin !== coin);
  }
  saveBeWatches();
  res.json({ success: true, watches: beWatches });
});

// Чекер раз в 60с: Limit P&L = filled × ask × (1 − marketFee) − usd; при ≥0 шлём алерт и снимаем вотч (одноразовый)
setInterval(async () => {
  if (!beWatches.length) return;
  const s = loadSettings();
  const fee = (parseFloat(s.marketFee) || 0.5) / 100;
  for (const w of [...beWatches]) {
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${w.pair}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
      if (!r.ok) continue;
      const t = await r.json();
      const ask = parseFloat(t.ask);
      if (!ask || !w.filled) continue;
      const pnl = w.filled * ask * (1 - fee) - w.usd;
      if (pnl >= 0) {
        const sent = await sendTelegram(`🔔 ${w.pair}: BREAK-EVEN reached!\nLimit P&L: +$${pnl.toFixed(2)} · Ask: $${ask}\nYou can sell without loss now. (one-shot alert — now OFF)`);
        beWatches = beWatches.filter(x => x.coin !== w.coin);
        saveBeWatches();
        console.log(`[be-watch] ${w.pair} fired at ask=${ask}, pnl=${pnl.toFixed(2)}, telegram=${sent}`);
      }
    } catch (e) { console.error('[be-watch]', w.pair, e.message); }
    await new Promise(r2 => setTimeout(r2, 200));
  }
}, 15_000); // каждые 15с — алерт приходит практически сразу после пересечения нуля

// Удалённый деплой: git pull + рестарт процесса (pm2 поднимет заново с новым кодом)
app.post('/api/deploy', (req, res) => {
  // НЕ УБИРАТЬ запасное значение, пока DEPLOY_KEY не появится в .env НА
  // СЕРВЕРЕ. Это уже вторая попытка: выглядит как дыра, но выкатка такого
  // кода — операция в один конец. На боевой машине переменной нет, после
  // рестарта эндпоинт начнёт отвечать 503, а другого способа доставить туда
  // код у нас нет — SSH отсутствует, деплой идёт через этот же обработчик.
  // То есть правка отключает единственный инструмент, которым её саму можно
  // было бы откатить. Секретности запасное значение и так не добавляет: оно
  // лежит в истории git. Порядок такой: сначала DEPLOY_KEY в .env на сервере
  // и перезапуск, потом эта строка.
  const deployKey = DEPLOY_KEY || 'trading-deploy-2026';
  if (!DEPLOY_KEY) {
    console.warn('[deploy] DEPLOY_KEY не задан в .env — работает запасной ключ из кода');
  }
  if (!constantTimeTokenEquals(String(req.query.key || req.headers['x-deploy-key'] || ''), deployKey)) {
    return res.status(403).json({ success: false, error: 'bad key' });
  }
  // Файлы с ЖИВЫМИ данными: настройки (там токен Telegram), история прибыли,
  // избранное, выбранная монета. Часть из них исторически попала под git, и
  // в репозитории лежат устаревшие копии — пустой токен и 42 записи истории
  // против 75 на сервере. Один коммит, случайно затронувший такой файл, стёр
  // бы их при следующем pull. Снимаем копию до pull и возвращаем после:
  // содержимое сервера всегда важнее содержимого репозитория.
  const PROTECTED = ['settings.json', 'profit-history.json', 'favorites.json',
    'selected-orders.json', 'selected-coin.json',
    // Добавлены после того, как коммит случайно затащил их в индекс и pull
    // на сервере упёрся в «untracked working tree files would be overwritten»
    'notified-fills.json', 'score-history.json'];
  const backup = new Map();
  for (const f of PROTECTED) {
    try {
      const fp = path.join(__dirname, f);
      if (fs.existsSync(fp)) backup.set(f, fs.readFileSync(fp, 'utf8'));
    } catch { }
  }
  const restore = () => {
    for (const [f, data] of backup) {
      try {
        const fp = path.join(__dirname, f);
        if (!fs.existsSync(fp) || fs.readFileSync(fp, 'utf8') !== data) {
          fs.writeFileSync(fp, data);
          console.log('[deploy] восстановлен ' + f);
        }
      } catch (e) { console.error('[deploy] не удалось вернуть ' + f + ':', e.message); }
    }
  };

  try {
    const { execSync } = require('child_process');
    let out;
    try {
      out = execSync('git pull', { cwd: __dirname, timeout: 60000 }).toString();
    } catch (pullErr) {
      // Локальные правки защищённых файлов мешают pull — убираем их из
      // рабочей копии и повторяем, содержимое всё равно вернём из копии.
      const msg = String(pullErr.stdout || '') + String(pullErr.stderr || '') + pullErr.message;
      if (/local changes|would be overwritten/i.test(msg)) {
        // Мешать может двумя способами: локальными правками отслеживаемого
        // файла и НЕотслеживаемым файлом, который входящий коммит хочет
        // создать. Копия уже снята, поэтому убираем и то и другое.
        for (const f of PROTECTED) {
          try { execSync(`git checkout -- ${f}`, { cwd: __dirname }); } catch { }
          try { fs.unlinkSync(path.join(__dirname, f)); } catch { }
        }
        out = execSync('git pull', { cwd: __dirname, timeout: 60000 }).toString();
        out = 'повтор после сброса защищённых файлов\n' + out;
      } else {
        throw pullErr;
      }
    }
    restore();
    const changed = !/Already up to date/i.test(out);
    res.json({ success: true, out, restarting: changed, protectedRestored: [...backup.keys()] });
    if (changed) setTimeout(() => process.exit(0), 500); // pm2 перезапустит процесс с новым кодом
  } catch (e) {
    restore();
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/score-stats', (req, res) => {
  // Только снапшоты новой трёхисходной схемы; rate = победы/(победы+проигрыши), таймауты отдельно
  const done = scoreHist.filter(s => s.r !== undefined && s.v === 2);
  const bucket = (lo, hi) => {
    const a = done.filter(s => s.s >= lo && s.s < hi);
    const w = a.filter(s => s.r === 1).length, l = a.filter(s => s.r === 0).length, t = a.filter(s => s.r === 2).length;
    return { n: w + l, wins: w, losses: l, timeouts: t, rate: (w + l) ? Math.round(w / (w + l) * 100) : null };
  };
  // История исходов по монетам: W/L/T + среднее время до цели (для тултипа и характера монеты)
  const perCoin = {};
  for (const s of done) {
    const a = perCoin[s.c] || (perCoin[s.c] = { w: 0, l: 0, to: 0, hs: 0, hn: 0 });
    if (s.r === 1) { a.w++; if (s.h != null) { a.hs += s.h; a.hn++; } }
    else if (s.r === 0) a.l++;
    else a.to++;
  }
  // Серия скоров за 6ч по каждой монете — для спарклайна в таблице
  const series = {};
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const s of scoreHist) {
    if (s.t < cutoff) continue;
    (series[s.c] || (series[s.c] = [])).push([s.t, s.s]);
  }
  for (const k in series) if (series[k].length > 24) series[k] = series[k].slice(-24);
  res.json({
    success: true,
    hi: bucket(7.5, 11), mid: bucket(5.5, 7.5), low: bucket(0, 5.5),
    total: scoreHist.length, pending: scoreHist.length - done.length,
    latest: latestScores, series, perCoin
  });
});

// Калибровка: какие сигналы реально предсказывают +2%. Для каждого сигнала —
// hit-rate снапшотов, где он присутствовал, против базового hit-rate всех оценённых.
app.get('/api/score-calibration', (req, res) => {
  // Только решённые исходы новой схемы (победа/проигрыш), таймауты исключены
  const done = scoreHist.filter(s => s.r !== undefined && s.v === 2 && s.r !== 2 && Array.isArray(s.pt));
  const base = done.length ? done.filter(s => s.r === 1).length / done.length : 0;
  const agg = {};
  for (const s of done) {
    const seen = new Set();
    for (const p of s.pt) {
      const name = p.split(':')[0].trim(); // «RSI: +1.5» → «RSI»
      if (seen.has(name)) continue;
      seen.add(name);
      const a = agg[name] || (agg[name] = { n: 0, hit: 0 });
      a.n++; if (s.r === 1) a.hit++;
    }
  }
  const signals = Object.entries(agg)
    .filter(([, a]) => a.n >= 10) // достаточно данных
    .map(([name, a]) => ({
      signal: name, n: a.n,
      rate: Math.round(a.hit / a.n * 100),
      lift: Math.round((a.hit / a.n - base) * 100) // +N п.п. к базовому = сигнал работает
    }))
    .sort((x, y) => y.lift - x.lift);
  res.json({
    success: true,
    base: Math.round(base * 100), evaluated: done.length,
    best: signals.slice(0, 8), worst: signals.slice(-8).reverse(),
    all: signals
  });
});

// Single-coin depth (kept for compatibility)
app.get('/api/coin-depth/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const price = parseFloat(req.query.price);
    if (!price) return res.status(400).json({ success: false, error: 'price required' });
    const now = Date.now();
    if (depthCache[coin] && now - depthCache[coin].ts < DEPTH_TTL) {
      return res.json({ success: true, coin, ...depthCache[coin].depth, cached: true });
    }
    const depth = await fetchCoinDepth(coin, price);
    depthCache[coin] = { depth, ts: now };
    res.json({ success: true, coin, ...depth });
  } catch (e) {
    console.error('[coin-depth]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Batch depth — POST { coins: [{coin, price}] } → parallel fetch all, return map
app.post('/api/all-depths', async (req, res) => {
  try {
    const list = Array.isArray(req.body && req.body.coins) ? req.body.coins : [];
    if (!list.length) return res.json({ success: true, depths: {} });
    const now = Date.now();
    const results = await Promise.all(list.map(async ({ coin, price }) => {
      const key = coin.toUpperCase();
      if (depthCache[key] && now - depthCache[key].ts < DEPTH_TTL) {
        return { coin: key, ...depthCache[key].depth };
      }
      const depth = await fetchCoinDepth(key, price);
      depthCache[key] = { depth, ts: now };
      return { coin: key, ...depth };
    }));
    const depths = {};
    for (const r of results) depths[r.coin] = { buy: r.buy, sell: r.sell };
    res.json({ success: true, depths });
  } catch (e) {
    console.error('[all-depths]', e.message);
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

// API: Coinbase's authoritative rolling 30-day volume and fee tier.
let volume30dCache = { data: null, ts: 0 };
const VOLUME_30D_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/get-volume-30d', async (req, res) => {
  try {
    const now = Date.now();
    // fresh=1 — обойти кеш. Нужен сразу после сделки: пятиминутный кеш иначе
    // показывал бы объём, не включающий только что совершённую операцию.
    const forceFresh = req.query.fresh === '1';
    if (!forceFresh && volume30dCache.data && (now - volume30dCache.ts) < VOLUME_30D_TTL) {
      return res.json({ success: true, ...volume30dCache.data, cached: true });
    }

    // Coinbase owns the fee tier and its rolling 30-day definition.  Its
    // transaction summary is therefore authoritative; rebuilding it from
    // individual fills can double-count partial executions across pages.
    const summaryRaw = await client.getTransactionSummary({});
    const summary = typeof summaryRaw === 'string' ? JSON.parse(summaryRaw) : summaryRaw;
    const totalUsd = Number(summary.total_volume);
    const totalFees = Number(summary.total_fees);
    const makerRate = Number(summary.fee_tier?.maker_fee_rate);
    const takerRate = Number(summary.fee_tier?.taker_fee_rate);
    if (!Number.isFinite(totalUsd) || totalUsd < 0 || !Number.isFinite(totalFees) || totalFees < 0) {
      throw new Error('Coinbase transaction summary returned invalid volume data');
    }
    const out = {
      totalUsd: Math.round(totalUsd * 100) / 100,
      totalFees: Math.round(totalFees * 100) / 100,
      feeTier: String(summary.fee_tier?.pricing_tier || ''),
      makerFeePct: Number.isFinite(makerRate) && makerRate >= 0 ? makerRate * 100 : null,
      takerFeePct: Number.isFinite(takerRate) && takerRate >= 0 ? takerRate * 100 : null,
      source: 'coinbase-transaction-summary',
      complete: true,
    };
    volume30dCache = { data: out, ts: now };
    return res.json({ success: true, ...out });

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

// ══════════════════════════════════════════════════════════════════
// ═══ 1. TRADE JOURNAL — реальные сделки + контекст входа ═══
// ══════════════════════════════════════════════════════════════════
const JOURNAL_FILE = path.join(__dirname, 'trade-journal.json');
let journal = { open: {}, closed: [] };
try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); } catch { }
if (!journal.open) journal.open = {};
if (!journal.closed) journal.closed = [];
function saveJournal() {
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2)); }
  catch (e) { console.error('[journal] save', e.message); }
}

// Контекст рынка на момент входа — только из уже готовых кешей, без лишних запросов
function captureEntryContext(coin) {
  const sc = latestScores[coin];
  const tl = topLosersCache.data.find(c => c.coin === coin);
  const tv = topVolumeCache.data.find(c => c.coin === coin);
  const btc = latestScores['BTC'];
  return {
    score: sc ? sc.score : null,
    scoreParts: sc && Array.isArray(sc.parts) ? sc.parts.slice(0, 15) : null,
    rb: tl ? tl.rb : null,
    rbTag: tl ? tl.rbTag : null,
    rbInfo: tl ? tl.rbInfo : null,
    pct30d: tl ? Math.round(tl.pct30d * 10) / 10 : null,
    pct24h: tv ? Math.round(tv.pct24h * 10) / 10 : null,
    pct1h: tv && tv.pct1h != null ? Math.round(tv.pct1h * 10) / 10 : null,
    btcScore: btc ? btc.score : null,
    hour: new Date().getHours()
  };
}

// Вызывается из checkFilledOrders для каждого нового FILLED ордера
function journalOnFill(o) {
  const coin = (o.product_id || '').replace('-USD', '');
  if (!coin) return;
  const size = parseFloat(o.filled_size) || 0;
  const usd = parseFloat(o.total_value) || 0; // after fees
  if (size <= 0 || usd <= 0) return;
  const price = parseFloat(o.average_filled_price) || 0;
  const t = o.created_time ? new Date(o.created_time).getTime() : Date.now();

  if (o.side === 'BUY') {
    let pos = journal.open[coin];
    if (!pos) {
      pos = journal.open[coin] = {
        coin, entryAt: t, origSize: 0, totalSize: 0, costTotal: 0, restCost: 0,
        realized: 0, buys: [], sells: [], ctx: captureEntryContext(coin)
      };
    }
    pos.buys.push({ orderId: o.order_id, price, size, usd, t });
    pos.origSize += size;
    pos.totalSize += size;
    pos.costTotal += usd;
    pos.restCost += usd;
    console.log(`[journal] BUY ${coin}: +${size} ($${usd.toFixed(2)}), ctx: score=${pos.ctx.score} rb=${pos.ctx.rb} tag=${pos.ctx.rbTag || '—'}`);
  } else if (o.side === 'SELL') {
    const pos = journal.open[coin];
    if (!pos || pos.totalSize <= 0) return; // продажа монеты, купленной до появления журнала
    const ratio = Math.min(1, size / pos.totalSize);
    const costBasis = pos.restCost * ratio;
    const realized = usd - costBasis;
    pos.sells.push({ orderId: o.order_id, price, size, usd, pnl: Math.round(realized * 100) / 100, t });
    pos.realized += realized;
    pos.totalSize -= size;
    pos.restCost -= costBasis;
    // Позиция закрыта, если осталось меньше 0.5% исходного размера (пыль)
    if (pos.totalSize <= Math.max(1e-9, pos.origSize * 0.005)) {
      const holdH = Math.round((t - pos.entryAt) / 3600000 * 10) / 10;
      journal.closed.push({
        coin, pnl: Math.round(pos.realized * 100) / 100,
        pnlPct: pos.costTotal > 0 ? Math.round(pos.realized / pos.costTotal * 10000) / 100 : 0,
        costTotal: Math.round(pos.costTotal * 100) / 100,
        entryAt: pos.entryAt, closedAt: t, holdH,
        ctx: pos.ctx, buys: pos.buys, sells: pos.sells
      });
      journal.closed = journal.closed.slice(-500);
      delete journal.open[coin];
      console.log(`[journal] CLOSED ${coin}: pnl=$${pos.realized.toFixed(2)} hold=${holdH}h`);
    }
  }
  saveJournal();
}

function journalStats() {
  const closed = journal.closed;
  const agg = (arr) => {
    const wins = arr.filter(x => x.pnl > 0).length;
    const losses = arr.length - wins;
    const total = arr.reduce((a, x) => a + x.pnl, 0);
    return {
      n: arr.length, wins, losses,
      winrate: arr.length ? Math.round(wins / arr.length * 100) : null,
      totalPnl: Math.round(total * 100) / 100,
      avgPnl: arr.length ? Math.round(total / arr.length * 100) / 100 : null,
      avgHoldH: arr.length ? Math.round(arr.reduce((a, x) => a + (x.holdH || 0), 0) / arr.length * 10) / 10 : null
    };
  };
  const groupBy = (keyFn) => {
    const m = {};
    for (const c of closed) {
      const k = keyFn(c);
      (m[k] || (m[k] = [])).push(c);
    }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, agg(v)]));
  };
  return {
    overall: agg(closed),
    byTag: groupBy(c => c.ctx && c.ctx.rbTag ? c.ctx.rbTag : '—'),
    byScore: groupBy(c => {
      const s = c.ctx ? c.ctx.score : null;
      if (s == null) return 'нет скора';
      return s >= 7.5 ? '7.5+' : s >= 5.5 ? '5.5–7.5' : '<5.5';
    }),
    byHour: groupBy(c => {
      const h = c.ctx && c.ctx.hour != null ? c.ctx.hour : new Date(c.entryAt).getHours();
      return `${String(Math.floor(h / 4) * 4).padStart(2, '0')}–${String(Math.floor(h / 4) * 4 + 4).padStart(2, '0')}`;
    })
  };
}

app.get('/api/journal', (req, res) => {
  res.json({ success: true, open: journal.open, closed: journal.closed.slice(-100).reverse(), stats: journalStats() });
});

app.delete('/api/journal/closed', (req, res) => {
  journal.closed = [];
  saveJournal();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ═══ Общие помощники для реальных ордеров (auto-exit) ═══
// ══════════════════════════════════════════════════════════════════
const productIncCache = new Map();
async function getProductIncrements(productId) {
  const cached = productIncCache.get(productId);
  if (cached) return cached;
  let baseDecimals = 8, quoteDecimals = 2;
  try {
    const r = await fetch(`https://api.exchange.coinbase.com/products/${productId}`);
    if (r.ok) {
      const prod = await r.json();
      const dec = inc => inc && inc.includes('.') ? (inc.split('.')[1].replace(/0+$/, '').length || 0) : 0;
      if (prod.base_increment) baseDecimals = dec(prod.base_increment);
      if (prod.quote_increment) quoteDecimals = dec(prod.quote_increment);
    }
  } catch { }
  const out = { baseDecimals, quoteDecimals };
  productIncCache.set(productId, out);
  return out;
}

function parseOrderResponse(response) {
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;
  if (parsed.success === false || parsed.error_response) {
    const msg = parsed.error_response?.message || parsed.error_response?.error || parsed.error_response?.preview_failure_reason || 'Order rejected';
    throw new Error(msg);
  }
  const orderId = parsed.success_response?.order_id || parsed.order_id;
  if (!orderId) throw new Error('No order ID returned');
  return orderId;
}

async function placeLimitSell(productId, size, price) {
  const { baseDecimals, quoteDecimals } = await getProductIncrements(productId);
  const orderData = {
    client_order_id: `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
    product_id: productId, side: 'SELL',
    order_configuration: {
      limit_limit_gtc: {
        base_size: parseFloat(size).toFixed(baseDecimals),
        limit_price: parseFloat(price).toFixed(quoteDecimals),
        post_only: false
      }
    }
  };
  const orderId = parseOrderResponse(await client.createOrder(orderData));
  ordersCache.ts = 0; balanceCache.ts = 0;
  return orderId;
}

async function placeMarketSell(productId, size) {
  const { baseDecimals } = await getProductIncrements(productId);
  const orderData = {
    client_order_id: `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`,
    product_id: productId, side: 'SELL',
    order_configuration: { market_market_ioc: { base_size: parseFloat(size).toFixed(baseDecimals) } }
  };
  const orderId = parseOrderResponse(await client.createOrder(orderData));
  ordersCache.ts = 0; balanceCache.ts = 0;
  return orderId;
}

async function getOrderInfo(orderId) {
  const result = await client.getOrder({ orderId });
  const raw = typeof result === 'string' ? JSON.parse(result) : result;
  const order = raw.order || raw;
  return {
    status: order.status,
    filledSize: parseFloat(order.filled_size) || 0,
    avgPrice: parseFloat(order.average_filled_price) || 0
  };
}

// ══════════════════════════════════════════════════════════════════
// ═══ 2. AUTO-EXIT — серверная TP/SL-лестница для реальных позиций ═══
// TP1/TP2/TP3 лимитками сразу, SL следит сервер; после TP1 стоп в безубыток,
// после TP2 стоп на уровень TP1. SL исполняется маркет-ордером.
// ══════════════════════════════════════════════════════════════════
const AUTO_EXIT_FILE = path.join(__dirname, 'auto-exits.json');
let autoExits = [];
try { autoExits = JSON.parse(fs.readFileSync(AUTO_EXIT_FILE, 'utf8')); } catch { }
function saveAutoExits() {
  try { fs.writeFileSync(AUTO_EXIT_FILE, JSON.stringify(autoExits, null, 2)); }
  catch (e) { console.error('[auto-exit] save', e.message); }
}
const AUTO_EXIT_DEFAULTS = { tp1Pct: 1.5, tp2Pct: 3, tp3Pct: 5, slPct: 3 };

function fmtPxAe(p) { p = parseFloat(p) || 0; return p < 0.001 ? p.toFixed(8) : p < 1 ? p.toFixed(6) : p < 100 ? p.toFixed(4) : p.toFixed(2); }

app.get('/api/auto-exit', (req, res) => {
  res.json({ success: true, watches: autoExits.filter(w => w.state === 'active'), closed: autoExits.filter(w => w.state !== 'active').slice(-20).reverse() });
});

app.post('/api/auto-exit', async (req, res) => {
  try {
    const { coin, pair, size, entryPrice, costUsd } = req.body || {};
    const p = (v, d) => { const x = parseFloat(v); return x > 0 ? x : d; };
    const tp1Pct = p(req.body.tp1Pct, AUTO_EXIT_DEFAULTS.tp1Pct);
    const tp2Pct = p(req.body.tp2Pct, AUTO_EXIT_DEFAULTS.tp2Pct);
    const tp3Pct = p(req.body.tp3Pct, AUTO_EXIT_DEFAULTS.tp3Pct);
    const slPct = p(req.body.slPct, AUTO_EXIT_DEFAULTS.slPct);
    const sz = parseFloat(size), entry = parseFloat(entryPrice);
    if (!coin || !sz || sz <= 0 || !entry || entry <= 0) {
      return res.status(400).json({ success: false, error: 'coin, size, entryPrice required' });
    }
    if (autoExits.some(w => w.coin === coin && w.state === 'active')) {
      return res.json({ success: false, error: `${coin}: auto-exit уже активен` });
    }
    const productId = pair || `${coin}-USD`;
    const { baseDecimals } = await getProductIncrements(productId);
    const rnd = v => parseFloat(v.toFixed(baseDecimals));
    const s1 = rnd(sz * 0.40), s2 = rnd(sz * 0.35);
    const s3 = rnd(sz - s1 - s2);
    if (s3 <= 0) return res.json({ success: false, error: 'Размер слишком мал для лестницы из 3 частей' });
    const tps = [
      { level: 1, pct: tp1Pct, size: s1, price: entry * (1 + tp1Pct / 100), orderId: null, filled: false, cancelled: false },
      { level: 2, pct: tp2Pct, size: s2, price: entry * (1 + tp2Pct / 100), orderId: null, filled: false, cancelled: false },
      { level: 3, pct: tp3Pct, size: s3, price: entry * (1 + tp3Pct / 100), orderId: null, filled: false, cancelled: false },
    ];
    const placed = [];
    try {
      for (const tp of tps) {
        tp.orderId = await placeLimitSell(productId, tp.size, tp.price);
        placed.push(tp.orderId);
      }
    } catch (e) {
      // одна из лимиток не встала — откатываем уже выставленные
      if (placed.length) { try { await client.cancelOrders({ order_ids: placed }); } catch { } }
      return res.json({ success: false, error: `TP order failed: ${e.message}` });
    }
    const watch = {
      id: `ae_${Date.now()}`, coin, pair: productId,
      size: sz, entryPrice: entry, costUsd: parseFloat(costUsd) || 0,
      slPct, sl: entry * (1 - slPct / 100), slStage: 'initial', // initial → breakeven → tp1
      tps, state: 'active', createdAt: Date.now(), log: []
    };
    autoExits.push(watch);
    saveAutoExits();
    await sendTelegram(
      `🎯 <b>AUTO-EXIT ARMED</b> — <b>${productId}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📦 Size: ${sz} ${coin} @ $${fmtPxAe(entry)}\n` +
      `🎯 TP1 +${tp1Pct}% ($${fmtPxAe(tps[0].price)}) — 40%\n` +
      `🎯 TP2 +${tp2Pct}% ($${fmtPxAe(tps[1].price)}) — 35%\n` +
      `🎯 TP3 +${tp3Pct}% ($${fmtPxAe(tps[2].price)}) — 25%\n` +
      `🛑 SL −${slPct}% ($${fmtPxAe(watch.sl)}) → BE после TP1`, 'HTML');
    res.json({ success: true, watch });
  } catch (e) {
    console.error('[auto-exit] arm', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/auto-exit/disarm', async (req, res) => {
  try {
    const { coin } = req.body || {};
    const w = autoExits.find(x => x.coin === coin && x.state === 'active');
    if (!w) return res.json({ success: false, error: 'not found' });
    const openIds = w.tps.filter(t => t.orderId && !t.filled && !t.cancelled).map(t => t.orderId);
    if (openIds.length) { try { await client.cancelOrders({ order_ids: openIds }); } catch (e) { console.warn('[auto-exit] cancel on disarm:', e.message); } }
    w.state = 'disarmed';
    w.closedAt = Date.now();
    saveAutoExits();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

let autoExitTickRunning = false;
async function autoExitTick() {
  if (autoExitTickRunning) return;
  const active = autoExits.filter(w => w.state === 'active');
  if (!active.length) return;
  autoExitTickRunning = true;
  try {
    for (const w of active) {
      // Пользователь мог снять авто-выход, пока тик ждал ответы биржи.
      // Без этой проверки мы продавали снятую позицию маркетом.
      if (w.state !== 'active') continue;
      try {
        let changed = false;
        // 1) статусы TP-ордеров
        for (const tp of w.tps) {
          if (w.state !== 'active') break;
          if (!tp.orderId || tp.filled || tp.cancelled) continue;
          const info = await getOrderInfo(tp.orderId);
          if (info.status === 'FILLED') {
            tp.filled = true; changed = true;
            w.log.push({ t: Date.now(), ev: `TP${tp.level} filled @ $${fmtPxAe(info.avgPrice || tp.price)}` });
            await sendTelegram(`✅ <b>TP${tp.level} FILLED</b> — <b>${w.pair}</b>\n${tp.size} ${w.coin} @ $${fmtPxAe(info.avgPrice || tp.price)} (+${tp.pct}%)`, 'HTML');
          } else if (info.status === 'CANCELLED') {
            tp.cancelled = true; changed = true;
            w.log.push({ t: Date.now(), ev: `TP${tp.level} cancelled externally` });
          }
        }
        // 2) подтяжка стопа
        if (w.tps[0].filled && w.slStage === 'initial') {
          w.sl = w.entryPrice; w.slStage = 'breakeven'; changed = true;
          w.log.push({ t: Date.now(), ev: `SL → breakeven $${fmtPxAe(w.sl)}` });
          await sendTelegram(`🛡 <b>${w.pair}</b>: SL moved to breakeven ($${fmtPxAe(w.sl)})`, 'HTML');
        }
        if (w.tps[1].filled && w.slStage === 'breakeven') {
          w.sl = w.tps[0].price; w.slStage = 'tp1'; changed = true;
          w.log.push({ t: Date.now(), ev: `SL → TP1 $${fmtPxAe(w.sl)}` });
          await sendTelegram(`🛡 <b>${w.pair}</b>: SL moved to TP1 level ($${fmtPxAe(w.sl)})`, 'HTML');
        }
        // 3) все цели сняты?
        if (w.tps.every(t => t.filled || t.cancelled)) {
          if (w.tps.every(t => t.filled)) {
            w.state = 'closed'; w.closeReason = 'ALL_TP'; w.closedAt = Date.now(); changed = true;
            const gross = w.tps.reduce((a, t) => a + t.size * t.price, 0);
            const pnl = w.costUsd > 0 ? gross - w.costUsd : null;
            await sendTelegram(`🏁 <b>AUTO-EXIT DONE</b> — <b>${w.pair}</b>\nAll 3 TP filled.${pnl != null ? ` PnL ≈ <b>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</b>` : ''}`, 'HTML');
          } else {
            w.state = 'closed'; w.closeReason = 'ORDERS_GONE'; w.closedAt = Date.now(); changed = true;
          }
          if (changed) saveAutoExits();
          continue;
        }
        // 4) проверка SL по текущей цене
        const r = await fetch(`https://api.exchange.coinbase.com/products/${w.pair}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
        if (r.ok) {
          const t = await r.json();
          const bid = parseFloat(t.bid || t.price);
          if (bid > 0 && bid <= w.sl) {
            const openTps = w.tps.filter(x => x.orderId && !x.filled && !x.cancelled);
            const ids = openTps.map(x => x.orderId);
            if (ids.length) { try { await client.cancelOrders({ order_ids: ids }); } catch (e) { console.warn('[auto-exit] SL cancel:', e.message); } }
            const remaining = w.tps.filter(x => !x.filled).reduce((a, x) => a + x.size, 0);
            let sellOk = false, sellErr = '';
            if (remaining > 0) {
              try { await placeMarketSell(w.pair, remaining); sellOk = true; }
              catch (e) { sellErr = e.message; console.error('[auto-exit] SL market sell:', e.message); }
            }
            w.state = 'closed';
            w.closeReason = w.slStage === 'initial' ? 'SL' : 'TRAIL_SL';
            w.closedAt = Date.now(); changed = true;
            w.log.push({ t: Date.now(), ev: `SL hit @ $${fmtPxAe(bid)}, market sell ${remaining} ${w.coin} ${sellOk ? 'OK' : 'FAILED: ' + sellErr}` });
            await sendTelegram(
              `🛑 <b>STOP ${w.slStage === 'initial' ? 'LOSS' : '(protected)'}</b> — <b>${w.pair}</b>\n` +
              `Price $${fmtPxAe(bid)} ≤ SL $${fmtPxAe(w.sl)}\n` +
              `Market sell ${remaining} ${w.coin}: ${sellOk ? '✅ done' : '❌ ' + sellErr}`, 'HTML');
          }
        }
        if (changed) saveAutoExits();
      } catch (e) { console.error('[auto-exit]', w.coin, e.message); }
      await sleep(250);
    }
  } finally { autoExitTickRunning = false; }
}
setInterval(autoExitTick, 20_000);

// ══════════════════════════════════════════════════════════════════
// ═══ 3. PAPER BOT — виртуальная торговля по сигналам «ПОКУПАТЬ» ═══
// Каждый сигнал Top Losers открывает виртуальную позицию и ведёт её:
// SL −3%, TP +5%, BE после +2.5%, трейлинг 1.5% после +4%, лимит 72ч.
// Через 2-3 недели статистика покажет, зарабатывает ли rebound score.
// ══════════════════════════════════════════════════════════════════
const PAPER_FILE = path.join(__dirname, 'paper-trades.json');
let paperBot = { enabled: false, budgetUsd: 100, open: [], closed: [] };
try {
  const saved = JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8'));
  paperBot = { ...paperBot, ...saved };
} catch { }
function savePaperBot() {
  try { fs.writeFileSync(PAPER_FILE, JSON.stringify(paperBot, null, 2)); }
  catch (e) { console.error('[paper] save', e.message); }
}
// Стоп по умолчанию −6% — это АВАРИЙНЫЙ, а не рабочий стоп.
// Замер на 289 входах гейта (7 дней, свечи 5m, цель +1.38%):
//   без защиты      +1.029% на сделку, худшая сделка −8.0%
//   стоп −6%        +0.914%,           худшая −6.3%   ← берём
//   стоп −3%        +0.717%,           худшая −3.3%
//   стоп −1.5%      +0.469%
//   выход по EMA9   −0.095% и хуже (режет будущих победителей)
// 98% сделок доходят до цели за сутки, поэтому близкий стоп превращает
// победителей в убытки. Дальний стоит 11% преимущества и обрезает хвост.
// maxHoldH 0 = без лимита времени: держим до цели.
const PAPER_CFG = { slPct: 6, tpPct: 5, beAfterPct: 2.5, trailAfterPct: 4, trailPct: 1.5, maxHoldH: 0, cooldownH: 12, warnPct: 4 };

// Комиссия лимитного ордера из настроек — paper эмулирует лимитку, а не рынок
function paperLimitFee() {
  const s = loadSettings();
  return (parseFloat(s.tradeFee) || defaultSettings.tradeFee) / 100;
}
// Цель paper/лаборатории отвязана от Sell Markup: тот управляет РЕАЛЬНЫМИ
// продажами, менять его ради эксперимента нельзя.
// Замер на 168 входах текущего гейта (стоп −6%, комиссия круга 0.25%):
//   цель +0.6%  → доходят 96%, но ожидание всего +0.142% (комиссия ест 42%)
//   цель +1.38% → 95%, +0.844%
//   цель +2.0%  → ожидание примерно вдвое выше, устойчиво 3/3 отрезка
//   цель +5%    → +3.067%, но это во многом заслуга растущей недели:
//                 на третьем отрезке результат падает в восемь раз
// Берём 2.0% — вдвое лучше прежнего и не опирается на бычий рынок.
function paperTargetPct() {
  if (paperBot.targetPct != null) return paperBot.targetPct;
  return 2.0;
}

// PnL как в реальной сделке: купили лимиткой по ask, продаём лимиткой — комиссия с обеих сторон
function paperPnl(pos, price) {
  const fee = pos.feePct != null ? pos.feePct : paperLimitFee();
  const qty = pos.qty != null ? pos.qty : (pos.budget * (1 - fee) / pos.entry);
  const out = qty * price * (1 - fee);
  return Math.round((out - pos.budget) * 100) / 100;
}

// Цена, при которой сделка закроется по твоему марк-апу (с учётом обеих комиссий)
function paperTargetPrice(pos) {
  return pos.entry * (1 + (pos.targetPct != null ? pos.targetPct : paperTargetPct()) / 100);
}

// Лучший ask — вход эмулируем так, будто сразу купил лимиткой по лучшему предложению
const latestBestQuotes = new Map();
async function fetchBestQuote(productId) {
  try {
    const response = await fetch(`https://api.exchange.coinbase.com/products/${productId}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
    if (!response.ok) return null;
    const ticker = await response.json();
    const bid = parseFloat(ticker.bid);
    const ask = parseFloat(ticker.ask);
    if (!(bid > 0) || !(ask > 0) || bid > ask) return null;
    const mid = (ask + bid) / 2;
    const spreadPct = (ask - bid) / mid * 100;
    if (!Number.isFinite(spreadPct) || spreadPct < 0) return null;
    return { ask, bid, spreadPct: Math.round(spreadPct * 1000) / 1000, at: Date.now() };
  } catch { return null; }
}

async function fetchBestAsk(productId) {
  const quote = await fetchBestQuote(productId);
  if (!quote) return 0;
  latestBestQuotes.set(productId, quote);
  return quote.ask;
}

// Собрать позицию по текущим настройкам — общий код для ручного и автоматического входа
function buildPaperPos(coin, pair, ask, ctx, source) {
  const fee = paperLimitFee();
  const targetPct = paperTargetPct();
  const budget = paperBot.budgetUsd;
  // Стоп настраивается: 0 = без стопа (как в реальной торговле — держим до цели)
  const slPct = paperBot.slPct != null ? paperBot.slPct : PAPER_CFG.slPct;
  return {
    id: `p${source === 'manual' ? 'm' : 'p'}_${Date.now()}_${coin}`,
    coin, pair, source,
    entry: ask,                       // лучший ask на момент входа
    qty: budget * (1 - fee) / ask,    // сколько монет реально получили после комиссии
    feePct: fee, targetPct, slPct,
    last: ask, peak: ask, budget,
    sl: slPct > 0 ? ask * (1 - slPct / 100) : 0,
    slStage: slPct > 0 ? (slPct >= 5 ? 'аварийный' : 'SL') : 'без стопа',
    openedAt: Date.now(), ctx: ctx || {}
  };
}

function closePaperPos(pos, price, reason) {
  pos.closedAt = Date.now();
  pos.exit = price;
  pos.reason = reason;
  pos.pnl = paperPnl(pos, price);
  pos.pnlPct = Math.round(pos.pnl / pos.budget * 10000) / 100;
  pos.holdH = Math.round((pos.closedAt - pos.openedAt) / 3600000 * 10) / 10;
  paperBot.open = paperBot.open.filter(p => p.id !== pos.id);
  paperBot.closed.push(pos);
  paperBot.closed = paperBot.closed.slice(-300);
  console.log(`[paper] CLOSE ${pos.coin} ${reason}: ${pos.pnl >= 0 ? '+' : ''}$${pos.pnl} (${pos.pnlPct}%)`);
  // Telegram намеренно молчит: единственный источник сообщений — кнопка BUY (одноразовый вотч)
}

let paperTickRunning = false;
async function paperBotTick() {
  if (paperTickRunning) return;
  paperTickRunning = true;
  try {
    let changed = false;
    // 1) ведём открытые позиции (даже если приём новых сигналов выключен)
    for (const pos of [...paperBot.open]) {
      try {
        const r = await fetch(`https://api.exchange.coinbase.com/products/${pos.pair}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
        if (!r.ok) continue;
        const t = await r.json();
        const price = parseFloat(t.price || t.bid);
        if (!(price > 0)) continue;
        pos.last = price;
        if (price > pos.peak) pos.peak = price;
        const g = (price - pos.entry) / pos.entry * 100; // грязное изменение, %
        const hasSl = (pos.slPct == null ? PAPER_CFG.slPct : pos.slPct) > 0;
        // Глубокий минус отмечаем флагом для интерфейса. В Telegram не пишем:
        // paper — это симуляция, единственный источник сообщений — кнопка Алерт.
        const warnAt = paperBot.warnPct != null ? paperBot.warnPct : PAPER_CFG.warnPct;
        if (warnAt > 0 && !pos.warned && g <= -warnAt) {
          pos.warned = true; changed = true;
          console.log(`[paper] ${pos.coin} глубоко в минусе: ${g.toFixed(1)}%`);
        }
        // Подтяжка стопа имеет смысл только если стоп вообще включён.
        // При цели 1.38% трейлинг не нужен — цель ближе, чем порог трейлинга.
        if (hasSl) {
          const tgtPct = pos.targetPct != null ? pos.targetPct : PAPER_CFG.tpPct;
          if (tgtPct > PAPER_CFG.beAfterPct) {
            if (g >= PAPER_CFG.beAfterPct && pos.sl < pos.entry) { pos.sl = pos.entry; pos.slStage = 'BE'; changed = true; }
            const peakG = (pos.peak - pos.entry) / pos.entry * 100;
            if (peakG >= PAPER_CFG.trailAfterPct) {
              const trailSl = pos.peak * (1 - PAPER_CFG.trailPct / 100);
              if (trailSl > pos.sl) { pos.sl = trailSl; pos.slStage = 'TRAIL'; changed = true; }
            }
          }
        }
        const ageH = (Date.now() - pos.openedAt) / 3600000;
        // Цель — твой Sell Markup из настроек (как в реальной торговле), а не фиксированные 5%
        const tgt = pos.targetPct != null ? pos.targetPct : PAPER_CFG.tpPct;
        // Закрываем только по цели. Стоп и лимит времени — опциональные:
        // 0 в настройках выключает их, и позиция висит до цели или до ручного ✕.
        const maxHold = paperBot.maxHoldH != null ? paperBot.maxHoldH : PAPER_CFG.maxHoldH;
        if (g >= tgt) { closePaperPos(pos, price, 'TP'); changed = true; }
        else if (hasSl && price <= pos.sl) { closePaperPos(pos, price, pos.slStage === 'TRAIL' ? 'TRAIL' : pos.slStage === 'BE' ? 'BE' : 'SL'); changed = true; }
        else if (maxHold > 0 && ageH >= maxHold) { closePaperPos(pos, price, 'TIME'); changed = true; }
      } catch (e) { console.error('[paper] manage', pos.coin, e.message); }
      await sleep(150);
    }
    // 2) новые сигналы из Top Losers
    if (paperBot.enabled && topLosersCache.data.length) {
      await refreshTopLosersPrices(false);
      // Режим входа: 'rev' — откалиброванный бэктестом гейт (по умолчанию),
      // 'rb' — старый вердикт ПОКУПАТЬ, 'both' — любой из двух.
      const mode = paperBot.entryMode || 'rev';
      const hits = topLosersCache.data.filter(c => {
        const rev = !!(c.rv && c.rv.pass);
        const rb = c.rbTag === 'ПОКУПАТЬ';
        return mode === 'rb' ? rb : mode === 'both' ? (rev || rb) : rev;
      });
      for (const c of hits) {
        if (paperBot.open.some(p => p.coin === c.coin)) continue;
        // кулдаун: не перезаходим в ту же монету N часов после закрытия
        const recent = [...paperBot.closed].reverse().find(p => p.coin === c.coin);
        if (recent && Date.now() - recent.closedAt < PAPER_CFG.cooldownH * 3600000) continue;
        // Вход как в реальной сделке — лимиткой по лучшему ask
        const ask = await fetchBestAsk(c.pair);
        if (!(ask > 0)) continue;
        const pos = buildPaperPos(c.coin, c.pair, ask, {
          rb: c.rb, rbInfo: c.rbInfo, rv: c.rv ? c.rv.score : null,
          rvTag: c.rv ? c.rv.tag : null, pct30d: Math.round(c.pct30d * 10) / 10
        }, 'auto');
        paperBot.open.push(pos);
        changed = true;
        console.log(`[paper] OPEN ${c.coin} ask=$${ask} target +${pos.targetPct}% (rb=${c.rb}, rv=${c.rv ? c.rv.score : '—'}, режим ${mode})`);
        // Telegram здесь молчит намеренно — алерты только через кнопку BUY
      }
    }
    if (changed) savePaperBot();
  } finally { paperTickRunning = false; }
}
setInterval(paperBotTick, 60_000);
setTimeout(paperBotTick, 25_000);

function paperStats() {
  const closed = paperBot.closed;
  const agg = (arr) => {
    const wins = arr.filter(x => x.pnl > 0).length;
    const total = arr.reduce((a, x) => a + x.pnl, 0);
    return {
      n: arr.length, wins, losses: arr.length - wins,
      winrate: arr.length ? Math.round(wins / arr.length * 100) : null,
      totalPnl: Math.round(total * 100) / 100,
      avgPnl: arr.length ? Math.round(total / arr.length * 100) / 100 : null,
      avgHoldH: arr.length ? Math.round(arr.reduce((a, x) => a + (x.holdH || 0), 0) / arr.length * 10) / 10 : null
    };
  };
  const byRb = {};
  for (const c of closed) {
    const rb = c.ctx ? c.ctx.rb : null;
    const k = rb == null ? '—' : rb >= 8.5 ? '8.5+' : rb >= 8 ? '8' : rb >= 7.5 ? '7.5' : '7';
    (byRb[k] || (byRb[k] = [])).push(c);
  }
  const byReason = {};
  for (const c of closed) (byReason[c.reason || '—'] || (byReason[c.reason || '—'] = [])).push(c);
  return {
    overall: agg(closed),
    byRb: Object.fromEntries(Object.entries(byRb).map(([k, v]) => [k, agg(v)])),
    byReason: Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, agg(v)]))
  };
}

app.get('/api/paper', (req, res) => {
  const open = paperBot.open.map(p => ({
    ...p, target: paperTargetPrice(p),
    pnl: p.last ? paperPnl(p, p.last) : null,
    pnlPct: p.last ? Math.round(paperPnl(p, p.last) / p.budget * 10000) / 100 : null
  }));
  res.json({
    success: true, enabled: paperBot.enabled, budgetUsd: paperBot.budgetUsd, entryMode: paperBot.entryMode || 'rev',
    slPct: paperBot.slPct != null ? paperBot.slPct : PAPER_CFG.slPct,
    maxHoldH: paperBot.maxHoldH || PAPER_CFG.maxHoldH,
    targetPct: paperTargetPct(), feePct: paperLimitFee() * 100,
    cfg: PAPER_CFG, open, closed: paperBot.closed.slice(-100).reverse(), stats: paperStats()
  });
});

app.post('/api/paper/config', (req, res) => {
  const { enabled, budgetUsd, entryMode } = req.body || {};
  if (enabled !== undefined) paperBot.enabled = !!enabled;
  if (budgetUsd !== undefined) {
    const b = parseFloat(budgetUsd);
    if (b >= 10 && b <= 100000) paperBot.budgetUsd = b;
  }
  if (entryMode !== undefined && ['rev', 'rb', 'both'].includes(entryMode)) paperBot.entryMode = entryMode;
  if (req.body.slPct !== undefined) {
    const v = parseFloat(req.body.slPct);
    if (v >= 0 && v <= 30) {
      paperBot.slPct = v;   // 0 = без стопа, держим до цели
      // Применяем и к уже открытым: иначе выключаешь стоп, а позиции всё
      // равно закрываются по старому — настройка выглядит неработающей.
      for (const p of paperBot.open) {
        p.slPct = v;
        p.sl = v > 0 ? p.entry * (1 - v / 100) : 0;
        p.slStage = v > 0 ? (v >= 5 ? 'аварийный' : 'SL') : 'без стопа';
      }
    }
  }
  if (req.body.maxHoldH !== undefined) {
    const v = parseFloat(req.body.maxHoldH);
    if (v >= 0 && v <= 8760) paperBot.maxHoldH = v;   // 0 = без лимита времени
  }
  if (req.body.targetPct !== undefined) {
    const v = parseFloat(req.body.targetPct);
    if (v >= 0.3 && v <= 20) paperBot.targetPct = v;  // цель эксперимента, не Sell Markup
  }
  savePaperBot();
  res.json({
    success: true, enabled: paperBot.enabled, budgetUsd: paperBot.budgetUsd,
    entryMode: paperBot.entryMode || 'rev',
    slPct: paperBot.slPct != null ? paperBot.slPct : PAPER_CFG.slPct,
    maxHoldH: paperBot.maxHoldH || PAPER_CFG.maxHoldH
  });
});

app.post('/api/paper/close', async (req, res) => {
  try {
    const pos = paperBot.open.find(p => p.id === req.body?.id);
    if (!pos) return res.json({ success: false, error: 'not found' });
    let price = pos.last || pos.entry;
    try {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${pos.pair}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
      if (r.ok) { const t = await r.json(); const px = parseFloat(t.price || t.bid); if (px > 0) price = px; }
    } catch { }
    closePaperPos(pos, price, 'MANUAL');
    savePaperBot();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/paper/closed', (req, res) => {
  paperBot.closed = [];
  savePaperBot();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ═══ REVERSAL SCORE — откалиброван историческим бэктестом ═══
// Бэктест (1635 сигналов, 144 монеты, апр–авг 2026) показал:
//   • просто «упала на 30%» → 37% побед при безубытке 37.5% — нет преимущества
//   • RSI<35, volume spike, капитуляция, divergence — нулевой или минусовой lift
//   • единственная связка, устойчивая на всех 3 отрезках времени:
//     цена выше EMA20(4H) + RSI вышел из перепроданности → 44% побед, PF 1.34
//   • глубина падения работает окном: −32…−50% лучшая зона, глубже −50% худшая
// Отсюда веса ниже: они измерены, а не придуманы.
// ══════════════════════════════════════════════════════════════════
const reversal = require('./src/reversal');

function calcReversalScore(d, s, btc) {
  const rsiRecovering = s.rsiMin7d != null && s.rsi4h != null && s.rsiMin7d < 30 && s.rsi4h > s.rsiMin7d + 4;
  const drop = d.pct30d;
  const liquid = d.vol24 >= 500e3;

  // Гейт входа — только то, что подтвердилось на истории
  const checks = [
    { k: 'Просадка в окне −32…−50%', ok: drop <= -32 && drop >= -50, v: drop.toFixed(1) + '%' },
    { k: 'Цена выше EMA20 (4H)', ok: !!s.aboveEma20_4h, v: s.aboveEma20_4h ? 'да' : 'нет' },
    { k: 'RSI вышел из перепроданности', ok: rsiRecovering, v: `${s.rsi4h ?? '—'} (мин 7д ${s.rsiMin7d ?? '—'})` },
    { k: 'Ликвидность ≥ $500K', ok: liquid, v: '$' + Math.round(d.vol24 / 1e3) + 'K' },
  ];
  const passed = checks.filter(c => c.ok).length;

  let sc = 0;
  // Окно просадки (макс 30) — немонотонно, по замеренным win-rate
  if (drop <= -60) sc += 4;               // win 32%, PF 0.78 — сломанный проект
  else if (drop < -50) sc += 10;          // строго ниже: ровно −50% входит в окно гейта
  else if (drop <= -40) sc += 30;         // win 44%, PF 1.30 — оптимум
  else if (drop <= -32) sc += 26;         // win 41%, PF 1.18
  else if (drop <= -25) sc += 12;         // win 35%, PF 0.89
  else sc += 5;
  if (s.aboveEma20_4h) sc += 25;          // ядро связки
  if (rsiRecovering) sc += 20;            // ядро связки
  if (d.vol24 >= 2e6) sc += 15; else if (d.vol24 >= 1e6) sc += 13; else if (d.vol24 >= 500e3) sc += 11; else if (d.vol24 >= 250e3) sc += 6;
  if (s.higherLow && s.higherLow.found) sc += 6;
  if (s.breakout && s.breakout.found) sc += 4;   // неустойчив — минимальный вес
  if (btc) { if (btc.aboveEma20) sc += 5; if (btc.pct4h < -1.5) sc -= 5; }
  // Потолок при блокирующих условиях: рейтинг не должен быть высоким у монеты,
  // которой нельзя торговать или которая в худшей по бэктесту группе
  if (!liquid) sc = Math.min(sc, 39);
  if (drop < -50) sc = Math.min(sc, 44);
  // Шкала должна быть однозначной: любая монета, прошедшая гейт, набирает
  // минимум 77 (26+25+20+11 −5 за падающий BTC). Поэтому всё, что гейт НЕ
  // прошло, потолком уводим ниже 77 — иначе 3/4 набирало до 85 и число
  // противоречило вердикту. Правило простое: 77+ ⇔ ВХОД.
  if (passed < 4) sc = Math.min(sc, 74);
  sc = Math.max(0, Math.min(100, Math.round(sc)));

  let tag;
  if (!liquid) tag = 'НЕЛИКВИД';
  else if (drop < -50) tag = 'СЛИШКОМ ГЛУБОКО';
  else if (passed === 4) tag = 'ВХОД';
  else if (passed === 3) tag = 'БЛИЗКО';
  else tag = 'ЖДАТЬ';

  return { score: sc, tag, pass: passed === 4, passed, checks, rsiRecovering, rsi: s.rsi4h, rsiMin: s.rsiMin7d, aboveEma: !!s.aboveEma20_4h, hl: !!(s.higherLow && s.higherLow.found), bo: !!(s.breakout && s.breakout.found) };
}

// Пересчёт рейтинга из уже загруженных сигналов + СВЕЖИХ цены и объёма.
// Дешёвый: без запросов. Вызывается на каждом обновлении цен, поэтому REV
// живёт вместе с ценой, а не застревает на состоянии момента пересборки.
function recomputeReversal(c) {
  if (!c.rvSig) return;
  const s = {
    ...c.rvSig,
    // EMA20 фиксирована до следующей пересборки, а цена живая — сравниваем с ней
    aboveEma20_4h: c.rvSig.ema20_4h != null ? c.price > c.rvSig.ema20_4h : c.rvSig.aboveEma20_4h
  };
  c.rv = calcReversalScore({ pct30d: c.pct30d, vol24: c.vol24 || 0 }, s, rvBtcRegime);
}

// Досчитываем reversal по монетам Top Losers (~20 шт) — вызывается после пересборки.
// ВАЖНО: перед расчётом обновляем цены, иначе vol24 берётся из текущей дневной
// свечи (в начале UTC-суток она почти пустая) и всё уезжает в НЕЛИКВИД.
let rvBtcRegime = null;
async function attachReversal(list) {
  try { rvBtcRegime = await reversal.getBtcRegime(); } catch { }
  try { await refreshTopLosersPrices(true); } catch { }
  // Снимок массива: refreshTopLosersPrices сортирует его на месте каждые 30с,
  // и обход «живого» массива перескакивал элементы — часть монет оставалась без оценки.
  // Объекты те же, поэтому проставленные поля попадают в кэш.
  const snapR = [...list];
  let doneR = 0;
  for (const c of snapR) {
    if (topLosersBuilding) tlProgress = { pct: 80 + Math.round(++doneR / snapR.length * 10), phase: 'свинг' };
    try {
      const s = await reversal.fetchReversalSignals(c.coin);
      if (!s) { c.rv = null; c.rvSig = null; continue; }
      c.rvSig = s;              // сырые сигналы храним — по ним идёт живой пересчёт
      recomputeReversal(c);
    } catch { c.rv = null; c.rvSig = null; }
    await sleep(180);
  }
  console.log(`[reversal] пересчитано ${list.filter(c => c.rv).length}/${list.length}, входов: ${list.filter(c => c.rv && c.rv.pass).length}`);
}

// ══════════════════════════════════════════════════════════════════
// ═══ SCALP SCORE — краткосрочный сигнал, горизонт 2-6 часов ═══
// Historical claims are not embedded here. The current gate is authorized only by scalp-gate-validation.json.
// ══════════════════════════════════════════════════════════════════
const scalp = require('./src/scalp');

let scalpRunning = false;
async function attachScalp() {
  if (scalpRunning || !topLosersCache.data.length) return;
  scalpRunning = true;
  try {
    // Снимок — по той же причине, что и в attachReversal (массив сортируется на месте)
    const snapS = [...topLosersCache.data];
    let doneS = 0;
    for (const c of snapS) {
      if (topLosersBuilding) tlProgress = { pct: 90 + Math.round(++doneS / snapS.length * 10), phase: 'скальп' };
      try {
        const s = await scalp.fetchScalpSignals(c.coin);
        if (!s) { c.sc = null; continue; }
        // Спред берём из уже кешированного стакана, если он свежий
        let spread = null;
        try {
          const r = await fetch(`https://api.exchange.coinbase.com/products/${c.pair}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
          if (r.ok) {
            const t = await r.json();
            const bid = parseFloat(t.bid), ask = parseFloat(t.ask);
            if (bid > 0 && ask > 0) spread = (ask - bid) / ((ask + bid) / 2) * 100;
          }
        } catch { }
        c.sc = scalp.calcScalpScore(s, c.vol24 || 0, spread);
        // Режим рынка — то же жёсткое условие, что в рыночном сканере
        if (c.sc) scalpScanner.applyRegime(c.sc, scalpScan.regime);
      } catch { c.sc = null; }
      await sleep(160);
    }
    const entries = topLosersCache.data.filter(c => c.sc && c.sc.pass);
    console.log(`[scalp] пересчитано ${topLosersCache.data.filter(c => c.sc).length}/${topLosersCache.data.length}, входов: ${entries.length}`);
    saveTopLosersCache();
  } catch (e) { console.error('[scalp]', e.message); }
  finally { scalpRunning = false; }
}
setInterval(attachScalp, 3 * 60 * 1000);
setTimeout(attachScalp, 50_000);

// ══════════════════════════════════════════════════════════════════
// ═══ СКАНЕР СКАЛЬПА ПО ВСЕМУ ЛИКВИДНОМУ РЫНКУ ═══
// Скальп-гейт не связан с падением за 30 дней — держать его только на
// Top Losers было ошибкой. Сканируем все ликвидные пары.
// ══════════════════════════════════════════════════════════════════
const scalpScanner = require('./src/scalp/scanner');

const scalpScan = { running: false, progress: 0, scanned: 0, total: 0, at: 0, results: [], regime: null, validation: null };
// Прошлый скан: по нему считаем, куда движется балл монеты и режим рынка.
// Держим здесь, а НЕ в src/scalp/*, потому что отпечаток гейта хэширует те
// файлы — добавление показательной мелочи туда обнулило бы поколение
// лаборатории, а это ровно то, что мы только что чинили.
const scalpPrev = { scores: new Map(), distPct: null, at: 0 };

function scalpValidationStatusLegacy() {
  // The scanner modules are loaded once by Node. A later disk hash may refer
  // to code that is not yet executing in this process.
  const fingerprint = typeof RUNTIME_GATE_FINGERPRINT === 'string'
    ? RUNTIME_GATE_FINGERPRINT : gateFingerprint();
  const diskFingerprint = gateFingerprint();
  if (!fingerprint || fingerprint !== diskFingerprint) {
    return {
      ready: false,
      state: 'restart_required',
      fingerprint: fingerprint || null,
      diskFingerprint: diskFingerprint || null,
    };
  }
  const found = inspectGateValidation(fingerprint);
  const result = found.result;
  const overall = result && result.overall;
  // Причину несовпадения отдаём наружу: интерфейс иначе советует перезапустить
  // валидатор там, где это не поможет — например когда прогон сделан с другой
  // комиссией, чем та, которой лаборатория считает сделки.
  if (!overall) return { ready: false, state: 'missing', why: found.why, detail: found.detail || null, detailEn: found.detailEn || null };
  const ready = overall.avgPct > 0 && overall.profitFactor > 1 && overall.positiveSegments === 3;
  return {
    ready,
    state: ready ? 'passed' : 'failed',
    fingerprint: result.fingerprint,
    generatedAt: result.generatedAt,
    n: overall.n,
    avgPct: overall.avgPct,
    profitFactor: overall.profitFactor,
    positiveSegments: overall.positiveSegments,
  };
}


function scalpValidationStatus() {
  const fingerprint = typeof RUNTIME_GATE_FINGERPRINT === 'string'
    ? RUNTIME_GATE_FINGERPRINT : gateFingerprint();
  const diskFingerprint = gateFingerprint();
  if (!fingerprint || fingerprint !== diskFingerprint) {
    return {
      ready: false, state: 'restart_required', fingerprint: fingerprint || null,
      diskFingerprint: diskFingerprint || null,
    };
  }
  const found = inspectGateValidation(fingerprint);
  const result = found.result;
  const overall = result && result.overall;
  if (!overall) {
    return { ready: false, state: 'missing', why: found.why, detail: found.detail || null,
      detailEn: found.detailEn || null };
  }
  const structuralReady = overall.avgPct > 0 && overall.profitFactor > 1 &&
    overall.positiveSegments === 3;
  const modeledChecks = Array.isArray(result.scope && result.scope.modeledChecks)
    ? result.scope.modeledChecks : [];
  const partialReplay = !modeledChecks.includes('Spread verified and <=0.4%');
  return {
    ready: partialReplay ? false : structuralReady,
    structuralReady,
    state: partialReplay ? 'partial' : structuralReady ? 'passed' : 'failed',
    fingerprint: result.fingerprint, generatedAt: result.generatedAt,
    n: overall.n, avgPct: overall.avgPct, profitFactor: overall.profitFactor,
    positiveSegments: overall.positiveSegments,
    scope: partialReplay ? 'structural-only' : 'complete',
    detail: partialReplay
      ? 'Historical replay omits the mandatory live spread check; it cannot authorize live entries.'
      : null,
  };
}

async function runScalpScan() {
  if (scalpScan.running) return;
  if (!cbVolumeCache.size) return;      // ждём общий кеш объёмов
  scalpScan.running = true;
  scalpScan.progress = 0;
  try {
    const out = await scalpScanner.scanMarket(cbVolumeCache, {
      minVol: 500e3, maxCoins: 160,
      onProgress: (done, total) => {
        scalpScan.scanned = done; scalpScan.total = total;
        scalpScan.progress = total ? Math.round(done / total * 100) : 0;
      },
    });
    const validation = scalpValidationStatus();
    // Тренд балла: до перезаписи результатов сравниваем с прошлым сканом
    for (const r of out.results) {
      const was = scalpPrev.scores.get(r.coin);
      r.scorePrev = was != null ? was : null;
      r.scoreDelta = was != null ? r.score - was : null;
      r.tradeReady = !!(r.pass && validation.ready);
    }
    if (out.regime) {
      out.regime.distPrev = scalpPrev.distPct;
      out.regime.distDelta = scalpPrev.distPct != null
        ? Math.round((out.regime.distPct - scalpPrev.distPct) * 100) / 100 : null;
      scalpPrev.distPct = out.regime.distPct;
    }
    scalpPrev.scores = new Map(out.results.map(r => [r.coin, r.score]));
    scalpPrev.at = out.at;

    scalpScan.results = out.results;
    scalpScan.regime = out.regime;
    scalpScan.at = out.at;
    scalpScan.validation = validation;
    const structuralEntries = out.results.filter(r => r.pass);
    const entries = out.results.filter(r => r.tradeReady);
    console.log(`[scalp-scan] ${out.results.length}/${out.total} монет, структурных: ${structuralEntries.length}, разрешено: ${entries.length}, validation=${validation.state}` +
      (out.regime ? ` · BTC ${out.regime.above ? 'выше' : 'НИЖЕ'} EMA20 (${out.regime.distPct}%)` : ''));
  } catch (e) { console.error('[scalp-scan]', e.message); }
  finally { scalpScan.running = false; scalpScan.progress = 100; }
}
// Период вынесен в константу: интерфейс показывает обратный отсчёт до
// следующего скана, и хардкодить его во втором месте значит рассинхрон.
const SCALP_SCAN_INTERVAL_MS = 4 * 60 * 1000;
setInterval(runScalpScan, SCALP_SCAN_INTERVAL_MS);
setTimeout(runScalpScan, 75_000);

app.use('/api/scalp-scan', (req, res, next) => {
  const validation = scalpValidationStatus();
  scalpScan.validation = validation;
  for (const result of scalpScan.results) {
    result.tradeReady = !!(result.pass && validation.ready);
  }
  next();
});

app.get('/api/scalp-scan', (req, res) => {
  if (req.query.refresh === '1' && !scalpScan.running) runScalpScan();
  const minScore = parseFloat(req.query.minScore) || 0;
  const onlyPass = req.query.pass === '1';
  let results = scalpScan.results;
  const validation = scalpScan.validation || scalpValidationStatus();
  // `pass` is only the raw structure. The public pass filter must not bypass
  // the independently validated-entry gate.
  if (onlyPass) results = results.filter(r => r.tradeReady);
  else if (minScore > 0) results = results.filter(r => r.score >= minScore);
  res.json({
    success: true,
    scanning: scalpScan.running, progress: scalpScan.progress,
    scanned: scalpScan.scanned, total: scalpScan.total,
    at: scalpScan.at, agoSec: scalpScan.at ? Math.round((Date.now() - scalpScan.at) / 1000) : null,
    intervalMs: SCALP_SCAN_INTERVAL_MS,
    serverNow: Date.now(),
    regime: scalpScan.regime,
    validation,
    entries: scalpScan.results.filter(r => r.tradeReady).length,
    structuralEntries: scalpScan.results.filter(r => r.pass).length,
    results: results.slice(0, 40),
    watch: scalpWatchArmed,
    watchLoop: scalpLoopOn,
  });
});

// ══════════════════════════════════════════════════════════════════
// ═══ ЛАБОРАТОРИЯ: фоновое тестирование гейта скальпа ═══
// Пока включена — открывает paper-сделку на каждый вход по гейту и
// запоминает полный контекст. Из закрытых сделок собирает наблюдения
// и готовый текст задания для доработки алгоритма.
// ══════════════════════════════════════════════════════════════════
const microScalpScanner = require('./src/micro-scalp/scanner');
const { createMicroLab } = require('./src/micro-scalp/lab');
const MICRO_SCALP_FILE = path.join(__dirname, 'micro-scalp-lab.json');
const MICRO_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const MICRO_TICK_INTERVAL_MS = 30 * 1000;
// Это порог только для вывода и решения о пересмотре Paper-эксперимента.
// Он не является условием входа и не меняет его отпечаток: текущая когорта
// должна спокойно дожить до осмысленной независимой выборки.
const MICRO_SCALP_MIN_CLOSED_BURSTS = 15;
const MICRO_EXECUTION = Object.freeze({
  targetPct: 1.0,
  slPct: 1.0,
  maxHoldMin: 60,
  executionModel: 'ask-entry / limit-target / observed-bid-stop-time-v1',
});
function microScalpFingerprint() {
  try {
    const source = ['src/micro-scalp/scanner.js', 'src/micro-scalp/lab.js']
      .map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n') +
      JSON.stringify(MICRO_EXECUTION);
    return crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}
const RUNTIME_MICRO_SCALP_FINGERPRINT = microScalpFingerprint();
const microScalpScan = { running: false, progress: 0, scanned: 0, total: 0, at: 0, results: [] };
const MICRO_SCALP_WATCH_FILE = path.join(__dirname, 'micro-scalp-watch.json');
const MICRO_SCALP_MAX_SCAN_AGE_MS = 3 * 60 * 1000;
const MICRO_SCALP_REARM_DROP = 0.5;
let microScalpWatchArmed = false;
let microScalpLoopOn = false;
let microScalpSent = {};
try {
  const savedWatch = JSON.parse(fs.readFileSync(MICRO_SCALP_WATCH_FILE, 'utf8'));
  microScalpWatchArmed = !!savedWatch.armed;
  microScalpLoopOn = !!savedWatch.loop;
  microScalpSent = savedWatch.sent && typeof savedWatch.sent === 'object' ? savedWatch.sent : {};
} catch { }
function saveMicroScalpWatch() {
  try {
    fs.writeFileSync(MICRO_SCALP_WATCH_FILE, JSON.stringify({
      armed: microScalpWatchArmed,
      loop: microScalpLoopOn,
      sent: microScalpSent,
    }), 'utf8');
  } catch (error) {
    console.error('[micro-scalp-watch] state save failed:', error.message);
  }
}
function currentMicroScalpExecution() {
  return { ...MICRO_EXECUTION, feePct: paperLimitFee() };
}
const microScalpLab = createMicroLab({
  file: MICRO_SCALP_FILE,
  runtimeFingerprint: RUNTIME_MICRO_SCALP_FINGERPRINT,
  getDiskFingerprint: microScalpFingerprint,
  getExecution: currentMicroScalpExecution,
  fetchQuote: fetchBestQuote,
  maxOpen: 3,
  maxEntrySpreadPct: microScalpScanner.MAX_SPREAD_PCT,
  log: message => console.log('[micro-lab] ' + message),
});
// Насколько монета близка ко входу. Это НЕ вероятность прибыли: связи между
// баллом и исходом никто не измерял, у лаборатории пока ноль закрытых сделок.
// Здесь только «сколько условий выполнено и насколько далеко ближайшее
// невыполненное от своего порога» — величина, считаемая из живых чисел.
//
// Живёт в server.js намеренно: отпечаток когорты хэширует src/micro-scalp/*,
// и правка там обнулила бы выборку, которую мы как раз копим.
function microScalpReadiness(row) {
  const checks = Array.isArray(row && row.checks) ? row.checks : [];
  if (!checks.length) return null;
  // Долю добираем только там, где у условия есть измеримый порог. У двоичных
  // (тренд EMA, режим BTC, неизмеренный спред) частичного зачёта нет: они либо
  // выполнены, либо нет.
  const share = (name) => {
    const clamp = v => Number.isFinite(v) ? Math.max(0, Math.min(0.95, v)) : 0;
    if (name.startsWith('Liquidity')) return clamp((Number(row.vol24) || 0) / 2e6);
    if (name.startsWith('Current 5m volume')) return clamp((Number(row.volumeX) || 0) / 0.8);
    if (name.startsWith('Pullback')) {
      const p = Number(row.pullbackPct);
      if (!Number.isFinite(p)) return 0;
      if (p < 0.10) return clamp(p / 0.10);
      if (p > 1.50) return clamp(1.50 / p);
      return 0;
    }
    if (name.startsWith('Spread')) {
      const s = Number(row.spreadPct);
      // Спред не измерен — это не «почти проходит», это неизвестность.
      return Number.isFinite(s) && s > 0 ? clamp(0.20 / s) : 0;
    }
    return 0;
  };
  let credit = 0;
  const missing = [];
  for (const c of checks) {
    if (c.ok) { credit += 1; continue; }
    missing.push(c.k);
    credit += share(String(c.k || ''));
  }
  return {
    pct: Math.round(credit / checks.length * 100),
    missing: missing.length,
    nearest: missing.length ? missing[0] : null,
  };
}

// Сила сетапа: та же картина, но взвешенная по важности, а не по числу
// условий. Готовность отвечает «сколько осталось до входа», и там все семь
// условий равны. Здесь другой вопрос — «насколько то, что сейчас на экране,
// похоже на сетап, который эта стратегия ищет».
//
// Ядро сетапа — падение, после которого начался разворот внутри растущего
// тренда. Оно весит 70 из 100: RSI вышел из получасового отката (30), сам
// откат в рабочем диапазоне (20), тренд по EMA выстроен (20). Остальные
// тридцать — издержки и фон: спред (12), ликвидность (8), объём (6), режим
// BTC (4). Они решают, во что обойдётся вход, но сетапом не являются.
//
// Это НЕ вероятность прибыли: связь между силой и исходом не измерена ни разу.
// Число говорит только одно — из того, что сейчас на рынке, вот эта монета
// ближе других к той картине, ради которой стратегия писалась.
//
// Живёт в server.js, а не в src/micro-scalp/*: правка там сменила бы отпечаток
// и обнулила набранную когорту.
const MICRO_SETUP_WEIGHTS = {
  'RSI 5m recovering from a 30m pullback': 30,
  'Pullback from 30m high is 0.10%–1.50%': 20,
  'Price above EMA9 and EMA9 above EMA21 (5m)': 20,
  'Spread verified and <=0.20%': 12,
  'Liquidity >= $2M': 8,
  'Current 5m volume >= 0.8x recent average': 6,
  'BTC above EMA20 (1h), fresh reading': 4,
};

function microScalpSetupStrength(row) {
  const checks = Array.isArray(row && row.checks) ? row.checks : [];
  if (!checks.length) return null;
  // Частичный зачёт там же, где он есть у готовности: у условия должен быть
  // измеримый порог. Двоичные либо выполнены, либо нет.
  const partial = (name) => {
    const clamp = v => Number.isFinite(v) ? Math.max(0, Math.min(0.9, v)) : 0;
    if (name.startsWith('Liquidity')) return clamp((Number(row.vol24) || 0) / 2e6);
    if (name.startsWith('Current 5m volume')) return clamp((Number(row.volumeX) || 0) / 0.8);
    if (name.startsWith('Pullback')) {
      const p = Number(row.pullbackPct);
      if (!Number.isFinite(p)) return 0;
      if (p < 0.10) return clamp(p / 0.10);
      if (p > 1.50) return clamp(1.50 / p);
      return 0;
    }
    if (name.startsWith('Spread')) {
      const s = Number(row.spreadPct);
      return Number.isFinite(s) && s > 0 ? clamp(0.20 / s) : 0;
    }
    return 0;
  };
  let got = 0, total = 0, core = 0, coreTotal = 0;
  for (const c of checks) {
    const name = String(c.k || '');
    const w = MICRO_SETUP_WEIGHTS[name];
    if (!w) continue;
    const share = c.ok ? 1 : partial(name);
    total += w;
    got += w * share;
    if (w >= 20) { coreTotal += w; core += w * share; }
  }
  if (!total) return null;
  return {
    pct: Math.round(got / total * 100),
    corePct: coreTotal ? Math.round(core / coreTotal * 100) : null,
  };
}

async function runMicroScalpScan() {
  if (microScalpScan.running || !cbVolumeCache.size) return;
  microScalpScan.running = true;
  microScalpScan.progress = 0;
  try {
    const out = await microScalpScanner.scanMarket(cbVolumeCache, scalpScan.regime, {
      maxCoins: 30,
      onProgress: (done, total) => {
        microScalpScan.scanned = done;
        microScalpScan.total = total;
        microScalpScan.progress = total ? Math.round(done / total * 100) : 0;
      },
    });
    for (const row of out.results) {
      row.readiness = microScalpReadiness(row);
      row.setupStrength = microScalpSetupStrength(row);
    }
    microScalpScan.results = out.results;
    microScalpScan.total = out.total;
    microScalpScan.at = out.at;
    console.log(`[micro-scalp] ${out.results.length}/${out.total} pairs, paper setups: ${out.results.filter(result => result.pass).length}`);
  } catch (error) {
    console.error('[micro-scalp]', error.message);
  } finally {
    microScalpScan.running = false;
    microScalpScan.progress = 100;
  }
}
async function tickMicroScalpLab() {
  try {
    await microScalpLab.tick({ results: microScalpScan.results, scanAt: microScalpScan.at });
  } catch (error) {
    console.error('[micro-lab]', error.message);
  }
}
setInterval(runMicroScalpScan, MICRO_SCAN_INTERVAL_MS);
setTimeout(runMicroScalpScan, 95_000);
setInterval(tickMicroScalpLab, MICRO_TICK_INTERVAL_MS);
setTimeout(tickMicroScalpLab, 115_000);
app.get('/api/micro-scalp-scan', (req, res) => {
  res.json({
    success: true,
    scanning: microScalpScan.running,
    progress: microScalpScan.progress,
    scanned: microScalpScan.scanned,
    total: microScalpScan.total,
    at: microScalpScan.at,
    agoSec: microScalpScan.at ? Math.round((Date.now() - microScalpScan.at) / 1000) : null,
    intervalMs: MICRO_SCAN_INTERVAL_MS,
    serverNow: Date.now(),
    entries: microScalpScan.results.filter(result => result.pass).length,
    results: microScalpScan.results.slice(0, 15),
    watch: microScalpWatchArmed,
    watchLoop: microScalpLoopOn,
    paperOnly: true,
    execution: currentMicroScalpExecution(),
  });
});
app.post('/api/micro-scalp-scan/refresh', (req, res) => {
  if (!cbVolumeCache.size) {
    return res.status(503).json({ success: false, error: 'Market volume cache is not ready yet' });
  }
  const wasRunning = microScalpScan.running;
  void runMicroScalpScan();
  res.json({ success: true, scanning: !wasRunning });
});
function microScalpReview(payload) {
  const closedBursts = Math.max(0, Number(payload && payload.bursts) || 0);
  return {
    closedBursts,
    minClosedBursts: MICRO_SCALP_MIN_CLOSED_BURSTS,
    remainingBursts: Math.max(0, MICRO_SCALP_MIN_CLOSED_BURSTS - closedBursts),
    ready: closedBursts >= MICRO_SCALP_MIN_CLOSED_BURSTS,
  };
}
app.get('/api/micro-scalp-lab', (req, res) => {
  const payload = microScalpLab.payload();
  res.json({ ...payload, review: microScalpReview(payload) });
});

const lab = require('./src/scalp/lab');
const LAB_FILE = path.join(__dirname, 'scalp-lab.json');
const LAB_MAX_HOLD_H = 48;

const LAB_MAX_SCAN_AGE_MS = 5 * 60 * 1000;
const LAB_MAX_ENTRY_SPREAD_PCT = 0.4;
const LAB_BURST_GAP_MS = 30 * 60 * 1000;
const GATE_VALIDATION_FILE = path.join(__dirname, 'scalp-gate-validation.json');
// Возвращает {result} при совпадении, либо {why, detail} — почему не подошло.
// Разделение нужно интерфейсу: «прогона нет» и «прогон есть, но про другой
// эксперимент» лечатся по-разному, а раньше оба показывались как «нет
// прогона» и советовали перезапустить валидатор, что во втором случае
// ничего не меняло — он бы записал тот же самый несовпадающий файл.
function inspectGateValidation(fingerprint) {
  let result;
  try {
    result = JSON.parse(fs.readFileSync(GATE_VALIDATION_FILE, 'utf8'));
  } catch {
    return { why: 'missing' };
  }
  if (!fingerprint || result.fingerprint !== fingerprint) {
    return { why: 'fingerprint', detail: `прогон для ${result.fingerprint || 'неизвестного кода'}, сейчас ${fingerprint || '?'}`,
      detailEn: `saved for ${result.fingerprint || 'unknown code'}, running ${fingerprint || '?'}` };
  }
  if (!result.config || result.config.days < 7 || !result.overall || result.overall.n < 30) {
    return { why: 'too_small', detail: `${(result.overall && result.overall.n) || 0} сделок за ${(result.config && result.config.days) || 0} дней`,
      detailEn: `${(result.overall && result.overall.n) || 0} trades over ${(result.config && result.config.days) || 0} days` };
  }
  const execution = currentLabExecution();
  // Одних правил входа мало: прогон с другой целью, стопом, комиссией или
  // окном удержания описывает другой эксперимент.
  // Две формулировки: русская идёт в интерфейс, английская — в задание для
  // Claude Code. Раньше русская протекала в английский текст, и собственная
  // проверка «задание без кириллицы» на этом падала.
  const diffs = [], diffsEn = [];
  const liveFee = Math.round(execution.feePct * 1e5) / 1e3;
  if (!sameNumber(result.config.targetPct, execution.targetPct)) {
    diffs.push(`цель ${result.config.targetPct}% против ${execution.targetPct}%`);
    diffsEn.push(`target ${result.config.targetPct}% vs ${execution.targetPct}%`);
  }
  if (!sameNumber(result.config.slPct, execution.slPct)) {
    diffs.push(`стоп ${result.config.slPct}% против ${execution.slPct}%`);
    diffsEn.push(`stop ${result.config.slPct}% vs ${execution.slPct}%`);
  }
  if (!sameNumber(result.config.feeSidePct, execution.feePct * 100)) {
    diffs.push(`комиссия ${result.config.feeSidePct}% против ${liveFee}%`);
    diffsEn.push(`fee ${result.config.feeSidePct}% vs ${liveFee}%`);
  }
  if (!sameNumber(result.config.maxHoldHours, execution.maxHoldH)) {
    diffs.push(`удержание ${result.config.maxHoldHours}ч против ${execution.maxHoldH}ч`);
    diffsEn.push(`hold ${result.config.maxHoldHours}h vs ${execution.maxHoldH}h`);
  }
  if (diffs.length) return { why: 'params', detail: diffs.join(', '), detailEn: diffsEn.join(', ') };
  return { result };
}

function loadGateValidation(fingerprint) {
  return inspectGateValidation(fingerprint).result || null;
}

// Отпечаток кода гейта. Любая правка в этих файлах меняет хэш — значит
// собранные до неё сделки относятся к прошлой версии алгоритма и мешать их
// со свежими нельзя. Раньше это надо было отмечать кнопкой вручную.
function gateFingerprint() {
  try {
    const crypto = require('crypto');
    const src = ['src/scalp/index.js', 'src/scalp/scanner.js']
      .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    // Хэшируем логику, а не файл целиком. Раньше отпечаток менялся от любой
    // правки — от комментария, от подписи условия, от переименования тега, —
    // и лаборатория выбрасывала накопленную выборку как «данные другого
    // алгоритма». За один день так сгорело четыре поколения подряд, ни одно
    // из-за изменения самого гейта. Убираем комментарии и пробелы: остаётся
    // код, который действительно решает, кого пускать.
    const logic = src
      .replace(/\/\*[\s\S]*?\*\//g, '')     // блочные комментарии
      .replace(/(^|[^:])\/\/.*$/gm, '$1')   // строчные, но не «://» в ссылках
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha1').update(logic).digest('hex').slice(0, 12);
  } catch { return null; }
}
// Сумма лаборатории зафиксирована: это измерение, а не торговля. Все выводы
// строятся на процентах, которые от суммы не зависят, а поле в интерфейсе
// только требовало решения там, где решать нечего. $1000 — чтобы долларовые
// итоги читались без нулей после запятой.
const LAB_BUDGET = 1000;
const LAB_SCHEMA_VERSION = 2;
const LAB_MAX_TRADES = 5000;
// Captured once at process start. The scanner modules are loaded once too.
const RUNTIME_GATE_FINGERPRINT = gateFingerprint();
let labState = {
  schemaVersion: LAB_SCHEMA_VERSION, enabled: false, startedAt: 0, budget: LAB_BUDGET,
  trades: [], briefAt: 0, generations: [], gateSnapshot: null, cohortId: null, runtimeMismatch: null,
  executionFingerprint: null, executionSnapshot: null,
};
try { labState = { ...labState, ...JSON.parse(fs.readFileSync(LAB_FILE, 'utf8')) }; } catch { }
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function sameNumber(a, b) {
  const left = finiteNumber(a), right = finiteNumber(b);
  return left != null && right != null && Math.abs(left - right) < 1e-9;
}
function currentLabExecution() {
  return {
    targetPct: paperTargetPct(),
    slPct: paperBot.slPct != null ? paperBot.slPct : PAPER_CFG.slPct,
    feePct: paperLimitFee(),
    maxHoldH: LAB_MAX_HOLD_H,
    executionModel: 'ask-entry / limit-target / observed-bid-stop-time-v2',
  };
}
function labExecutionFingerprint(execution = currentLabExecution()) {
  return [
    finiteNumber(execution.targetPct),
    finiteNumber(execution.slPct),
    finiteNumber(execution.feePct),
    finiteNumber(execution.maxHoldH),
    execution.executionModel || 'unknown',
  ].join('|');
}
function snapshotLabExecution(execution = currentLabExecution()) {
  return {
    targetPct: finiteNumber(execution.targetPct),
    slPct: finiteNumber(execution.slPct),
    feePct: finiteNumber(execution.feePct),
    maxHoldH: finiteNumber(execution.maxHoldH),
    executionModel: execution.executionModel || 'unknown',
  };
}
function makeExecutionAwareCohortId(fingerprint, at = Date.now(), execution = currentLabExecution()) {
  return makeLabCohortId(fingerprint, at) + ':' + labExecutionFingerprint(execution);
}
function makeLabCohortId(fingerprint, at = Date.now()) {
  return String(fingerprint || 'unknown') + ':' + at;
}
function labExecutionForTrade(trade) {
  const fallback = currentLabExecution();
  return {
    targetPct: finiteNumber(trade && trade.targetPct) ?? fallback.targetPct,
    slPct: finiteNumber(trade && trade.slPct) ?? fallback.slPct,
    feePct: finiteNumber(trade && trade.feePct) ?? fallback.feePct,
    maxHoldH: finiteNumber(trade && trade.maxHoldH) ?? fallback.maxHoldH,
    executionModel: trade && trade.executionModel || fallback.executionModel,
  };
}
function freezeLabExecution(trade, fallback = currentLabExecution()) {
  let changed = false;
  for (const [key, value] of Object.entries({
    targetPct: fallback.targetPct, slPct: fallback.slPct,
    feePct: fallback.feePct, maxHoldH: fallback.maxHoldH,
  })) {
    if (finiteNumber(trade[key]) == null) { trade[key] = value; changed = true; }
  }
  if (!trade.executionModel) { trade.executionModel = fallback.executionModel; changed = true; }
  if (!trade.executionCapturedAt) { trade.executionCapturedAt = Date.now(); changed = true; }
  return changed;
}
function labPnl(trade, price) {
  const execution = labExecutionForTrade(trade);
  const entry = finiteNumber(trade && trade.entry);
  const budget = finiteNumber(trade && trade.budget);
  const exit = finiteNumber(price);
  if (!(entry > 0) || !(budget > 0) || !(exit > 0)) return null;
  const qty = finiteNumber(trade.qty) ?? budget * (1 - execution.feePct) / entry;
  return Math.round((qty * exit * (1 - execution.feePct) - budget) * 100) / 100;
}
function labRuntimeStatus() {
  const diskFingerprint = gateFingerprint();
  const runtimeFingerprint = RUNTIME_GATE_FINGERPRINT;
  const matched = !!runtimeFingerprint && runtimeFingerprint === diskFingerprint;
  return {
    state: matched ? 'ready' : 'restart_required',
    matched, runtimeFingerprint, diskFingerprint,
    message: matched ? null : 'Gate files changed after this Node process started. Restart before collecting new entries.',
  };
}
function sameGateChecks(a, b) {
  return Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b);
}
function isCurrentLabTrade(trade) {
  if (!trade || trade.archivedAt ||
      trade.provenance === 'legacy-unverified' ||
      trade.gateFingerprint === 'legacy-unknown') return false;
  return !!trade && trade.cohortId === labState.cohortId && !trade.archivedAt;
}
function labBurstIdForEntry(openedAt, cohortId) {
  const latest = labState.trades
    .filter(trade => trade.cohortId === cohortId && typeof trade.burstId === 'string' &&
      trade.burstId && finiteNumber(trade.openedAt) != null && trade.openedAt <= openedAt &&
      openedAt - trade.openedAt <= LAB_BURST_GAP_MS)
    .sort((a, b) => b.openedAt - a.openedAt)[0];
  return latest ? latest.burstId : 'burst_' + cohortId + '_' + openedAt;
}
function normalizeLabState() {
  let changed = false;
  if (!Array.isArray(labState.trades)) { labState.trades = []; changed = true; }
  if (!Array.isArray(labState.generations)) { labState.generations = []; changed = true; }
  if (!labState.executionFingerprint) {
    labState.executionFingerprint = 'legacy-unknown';
    changed = true;
  }
  const legacyCohort = labState.cohortId || makeLabCohortId(labState.fingerprint || 'legacy-unknown', labState.startedAt || Date.now());
  if (!labState.cohortId) { labState.cohortId = legacyCohort; changed = true; }
  for (const trade of labState.trades) {
    if (!trade.cohortId) { trade.cohortId = legacyCohort; changed = true; }
    // Old rows cannot prove the version actually loaded by their process.
    if (!trade.gateFingerprint) { trade.gateFingerprint = 'legacy-unknown'; trade.provenance = 'legacy-unverified'; changed = true; }
    if (trade.gen === 'old' && !trade.archivedReason) { trade.archivedReason = 'archived by legacy journal'; changed = true; }
    if (freezeLabExecution(trade)) { trade.executionInferred = true; changed = true; }
  }
  if (labState.schemaVersion !== LAB_SCHEMA_VERSION) { labState.schemaVersion = LAB_SCHEMA_VERSION; changed = true; }
  return changed;
}

labState.budget = LAB_BUDGET;
const labStateDirty = normalizeLabState();

// Заметки поколений раньше приходили кириллицей через shell и доезжали
// побитыми (?????? и U+FFFD). Текст теперь пишется по-английски, а уже
// испорченные записи помечаем честно, вместо того чтобы показывать мусор.
function isMojibake(s) {
  if (!s) return false;
  const bad = (s.match(/[�?]/g) || []).length;
  return bad >= 8 && bad / s.length > 0.15;
}
const LEGACY_AUTO_NOTE = 'Код гейта изменён (обнаружено автоматически)';
for (const g of labState.generations || []) {
  // Авто-заметки, записанные до перехода на английский
  if (g.note === LEGACY_AUTO_NOTE) g.note = 'Gate code changed (detected automatically)';
  if (isMojibake(g.note)) {
    g.noteBroken = g.note;
    g.note = 'Note lost to a text-encoding failure when it was recorded. ' +
      'The stats and observations on this generation are intact.';
  }
}
function saveLab() {
  const stored = { ...labState, schemaVersion: LAB_SCHEMA_VERSION, trades: labState.trades };
  let tempFile = null;
  try {
    tempFile = LAB_FILE + '.' + process.pid + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(stored, null, 2), 'utf8');
    fs.renameSync(tempFile, LAB_FILE);
  } catch (e) {
    if (tempFile) { try { fs.unlinkSync(tempFile); } catch { } }
    console.error('[lab] save', e.message);
  }
}
if (labStateDirty) saveLab();

function archiveCurrentLabCohort(reason, nextFingerprint, nextChecks, note) {
  const nextExecution = arguments.length > 4 && arguments[4]
    ? arguments[4] : currentLabExecution();
  const now = Date.now();
  const oldCohort = labState.cohortId;
  const cohortTrades = labState.trades.filter(t => t.cohortId === oldCohort && !t.archivedAt);
  const completedPassers = cohortTrades.filter(t => t.closedAt && !t.shadow);
  const { base, observations } = lab.findObservations(completedPassers);
  if (cohortTrades.length) {
    labState.generations.push({
      at: now, auto: true, note: note || reason, reason,
      from: labState.fingerprint || null, to: nextFingerprint || null,
      cohortId: oldCohort, gateWas: labState.gateSnapshot || null,
      executionFingerprintWas: labState.executionFingerprint || null,
      executionWas: labState.executionSnapshot || null,
      trades: completedPassers.length, rawTrades: cohortTrades.length,
      openAtArchive: cohortTrades.filter(t => !t.closedAt).length,
      stats: base, observations: (observations || []).slice(0, 10),
    });
    labState.generations = labState.generations.slice(-50);
  }
  for (const trade of cohortTrades) {
    trade.gen = 'old';
    trade.archivedAt = now;
    trade.archivedReason = reason;
  }
  labState.cohortId = makeLabCohortId(nextFingerprint, now);
  labState.cohortId = makeExecutionAwareCohortId(nextFingerprint, now, nextExecution);
  labState.fingerprint = nextFingerprint || null;
  labState.gateSnapshot = Array.isArray(nextChecks) && nextChecks.length ? [...nextChecks] : null;
  labState.executionFingerprint = labExecutionFingerprint(nextExecution);
  labState.executionSnapshot = snapshotLabExecution(nextExecution);
  labState.startedAt = now;
  return true;
}
function reconcileLabCohort(liveChecks, runtime) {
  let changed = false;
  if (!runtime.matched) {
    const previous = labState.runtimeMismatch;
    if (!previous ||
        previous.runtimeFingerprint !== (runtime.runtimeFingerprint || null) ||
        previous.diskFingerprint !== (runtime.diskFingerprint || null) ||
        previous.message !== runtime.message) {
      labState.runtimeMismatch = {
        at: Date.now(), runtimeFingerprint: runtime.runtimeFingerprint || null,
        diskFingerprint: runtime.diskFingerprint || null, message: runtime.message,
      };
      changed = true;
    }
    return { changed, entriesAllowed: false };
  }
  if (labState.runtimeMismatch) { labState.runtimeMismatch = null; changed = true; }
  const nextFingerprint = runtime.runtimeFingerprint;
  const nextExecution = currentLabExecution();
  const nextExecutionFingerprint = labExecutionFingerprint(nextExecution);
  if (!labState.fingerprint ||
      labState.executionFingerprint !== nextExecutionFingerprint) {
    archiveCurrentLabCohort(
      labState.executionFingerprint === 'legacy-unknown'
        ? 'legacy journal has no frozen execution configuration'
        : 'execution configuration changed',
      nextFingerprint,
      liveChecks,
      'Execution parameters changed or were unverified; prior cohort archived for audit.',
      nextExecution
    );
    changed = true;
  }
  if (!labState.fingerprint) {
    labState.fingerprint = nextFingerprint;
    changed = true;
  } else if (labState.fingerprint !== nextFingerprint) {
    archiveCurrentLabCohort(
      'runtime gate fingerprint changed after a server restart', nextFingerprint, liveChecks,
      'Gate runtime changed after restart; prior cohort archived for audit.'
    );
    changed = true;
  }
  if (Array.isArray(liveChecks) && liveChecks.length) {
    if (!Array.isArray(labState.gateSnapshot) || !labState.gateSnapshot.length) {
      labState.gateSnapshot = [...liveChecks];
      changed = true;
    } else if (!sameGateChecks(labState.gateSnapshot, liveChecks)) {
      archiveCurrentLabCohort(
        'saved gate checks differ from the running scanner', nextFingerprint, liveChecks,
        'Saved gate snapshot did not match the loaded scanner; prior cohort archived as invalid for the current gate.'
      );
      changed = true;
    }
  }
  return { changed, entriesAllowed: true };
}

// Открываем виртуальные сделки на входах гейта. Отдельно от Paper Bot,
// чтобы ручные сделки не смешивались со статистикой эксперимента.
let labTickRunning = false;
async function labTick() {
  if (labTickRunning) return;
  labTickRunning = true;
  try {
    let changed = false;

    // Код гейта изменился → закрываем поколение автоматически. Сделки,
    // собранные по прошлой версии, уходят в архив, счёт начинается заново.
    const fp = gateFingerprint();
    if (fp && labState.fingerprint && fp !== labState.fingerprint) {
      const done = labState.trades.filter(t => t.closedAt && !t.shadow);
      const { base, observations } = lab.findObservations(done);
      labState.generations = labState.generations || [];
      // Состав гейта на момент закрытия поколения. Без него в разделе «уже
      // внедрено» стояло «код гейта изменился» и ни слова о том, ЧТО именно
      // изменилось — а именно этот раздел должен не давать предлагать одно и
      // то же по кругу. Снимок ведётся непрерывно, поэтому здесь под рукой
      // ещё СТАРЫЙ состав, до правки.
      labState.generations.push({
        at: Date.now(), auto: true,
        note: 'Gate code changed (detected automatically)',
        from: labState.fingerprint, to: fp,
        gateWas: labState.gateSnapshot || null,
        trades: done.length, stats: base, observations: (observations || []).slice(0, 10),
      });
      labState.generations = labState.generations.slice(-20);
      labState.trades = labState.trades.filter(t => !t.closedAt).map(t => ({ ...t, gen: 'old' }));
      labState.startedAt = Date.now();
      changed = true;
      console.log(`[lab] гейт изменён (${labState.fingerprint} → ${fp}): поколение #${labState.generations.length} закрыто, ${done.length} сделок в архиве`);
    }
    if (fp && fp !== labState.fingerprint) { labState.fingerprint = fp; changed = true; }
    // Держим снимок живого гейта в актуальном состоянии: он же станет
    // «как было» при следующей смене поколения
    const liveChecks = (scalpScan.results[0] && scalpScan.results[0].checks || []).map(c => c.en || c.k);
    if (liveChecks.length) {
      const snap = JSON.stringify(liveChecks);
      if (JSON.stringify(labState.gateSnapshot || null) !== snap) {
        labState.gateSnapshot = liveChecks;
        changed = true;
      }
    }
    const fee = paperLimitFee();
    const target = paperTargetPct();
    const slPct = paperBot.slPct != null ? paperBot.slPct : PAPER_CFG.slPct;

    // 1) ведём открытые
    for (const t of labState.trades.filter(x => !x.closedAt)) {
      try {
        const r = await fetch(`https://api.exchange.coinbase.com/products/${t.pair}/ticker`, { headers: { 'User-Agent': 'trading-app/1.0' } });
        if (!r.ok) continue;
        const tk = await r.json();
        const px = parseFloat(tk.bid || tk.price);
        if (!(px > 0)) continue;
        t.last = px;
        const g = (px - t.entry) / t.entry * 100;
        // Пик и дно за время сделки. Без них исход −6% по стопу и исход
        // «дошла до +1.9% и развернулась» в журнале неразличимы, хотя это
        // разные истории. С ними каждая закрытая сделка становится замером
        // ЛЮБОЙ цели и ЛЮБОГО стопа сразу — на тех же самых сделках, без
        // нового бэктеста.
        if (t.mfe == null || g > t.mfe) t.mfe = Math.round(g * 100) / 100;
        if (t.mae == null || g < t.mae) t.mae = Math.round(g * 100) / 100;
        const close = (exit, why) => {
          t.exit = exit; t.closedAt = Date.now(); t.why = why;
          const qty = t.budget * (1 - fee) / t.entry;
          t.pnl = Math.round((qty * exit * (1 - fee) - t.budget) * 100) / 100;
          t.pnlPct = Math.round(t.pnl / t.budget * 10000) / 100;
          t.holdH = Math.round((t.closedAt - t.openedAt) / 3600000 * 10) / 10;
          changed = true;
          console.log(`[lab] ${t.coin} ${why}: ${t.pnlPct}%`);
        };
        if (g >= target) close(t.entry * (1 + target / 100), 'TP');
        else if (slPct > 0 && g <= -slPct) close(t.entry * (1 - slPct / 100), 'SL');
        else if ((Date.now() - t.openedAt) / 3600000 >= 48) close(px, 'TIME');
      } catch { }
      await sleep(120);
    }

    // 2) новые входы. Кроме прошедших гейт берём КОНТРОЛЬНУЮ ГРУППУ: монеты,
    // которым не хватило ровно одного условия. Только по прошедшим невозможно
    // узнать, заслуживает ли условие своего места — нужен встречный пример.
    //
    // Плюс ВТОРОЙ круг контроля: те, кто провалил ровно два условия. Группа
    // «не хватило одного» отвечает, заслуживает ли места каждое условие по
    // отдельности, но не отвечает, не зажат ли гейт целиком — сколько живых
    // прибыльных входов мы просто никогда не видим. Держим их отдельно и
    // мельче: это разведка, а не проверка условия.
    if (labState.enabled) {
      const passers = scalpScan.results.filter(x => x.pass);
      const openShadows = labState.trades.filter(t => !t.closedAt && t.shadow && !t.far).length;
      const openFar = labState.trades.filter(t => !t.closedAt && t.far).length;
      const nearMiss = scalpScan.results
        .filter(x => !x.pass && x.checks && x.passed === x.checks.length - 1)
        .slice(0, Math.max(0, 12 - openShadows));   // потолок: тикеры тоже стоят запросов
      const farMiss = scalpScan.results
        .filter(x => !x.pass && x.checks && x.passed === x.checks.length - 2)
        .slice(0, Math.max(0, 6 - openFar));

      for (const r of [...passers, ...nearMiss, ...farMiss]) {
        const isShadow = !r.pass;
        const isFar = isShadow && r.passed === r.checks.length - 2;
        if (labState.trades.some(t => t.coin === r.coin && !t.closedAt)) continue;
        const recent = [...labState.trades].reverse().find(t => t.coin === r.coin && t.closedAt);
        const cooldown = (isShadow ? 6 : 4) * 3600 * 1000;
        if (recent && Date.now() - recent.closedAt < cooldown) continue;
        const ask = await fetchBestAsk(r.pair);
        if (!(ask > 0)) continue;
        // По-английски: это же название попадёт в таблицу проверки условий
        // внутри задания для Claude Code
        const failed = isShadow ? r.checks.filter(c => !c.ok).map(c => c.en || c.k) : [];
        const missing = failed.length ? failed.join(' + ') : null;
        labState.trades.push({
          id: `lab_${Date.now()}_${r.coin}`,
          coin: r.coin, pair: r.pair, entry: ask, last: ask,
          shadow: isShadow, far: isFar, missing,
          budget: labState.budget, openedAt: Date.now(),
          mfe: 0, mae: 0,          // пик и дно в % от входа, ведём на каждом тике
          // полный контекст входа — по нему потом ищем закономерности
          ctx: {
            score: r.score, rangePos: r.rangePos, rsi: r.rsi,
            rsiMin: r.rsiMin != null ? r.rsiMin : null,   // приходит числом из calcScalpScore
            spreadPct: r.spreadPct, vol24: r.vol24, volX: r.volX,
            btcDist: scalpScan.regime ? scalpScan.regime.distPct : null,
            hourUtc: new Date().getUTCHours(),
            // Гейт пропускает диапазон до 8% и рост до 15%, но внутри этих
            // границ ничего не различает. Пишем сами числа: живые сделки
            // могут показать, что разрешённая зона неоднородна.
            range4Pct: r.range4Pct != null ? r.range4Pct : null,
            runUp24: r.runUp24 != null ? r.runUp24 : null,
            // Насколько цена уже отошла от вершины 4ч диапазона: при
            // rangePos у дна это глубина падения, которую мы ловим
            dropFromHigh: r.dropFromHigh4Pct != null ? r.dropFromHigh4Pct : null,
          },
        });
        changed = true;
        console.log(`[lab] ${isFar ? 'разведка' : isShadow ? 'контроль' : 'вход'} ${r.coin} @ $${ask} (балл ${r.score}` +
          (isShadow ? `, не хватило: ${missing}` : '') + ')');
      }
    }
    if (changed) saveLab();
  } catch (e) { console.error('[lab]', e.message); }
  finally { labTickRunning = false; }
}
setInterval(labTickSafe, 60_000);

// Safe journal loop. It intentionally keeps managing archived open positions,
// but it never admits a new entry while source files and loaded scanner differ.
let labTickSafeRunning = false;
async function labTickSafe() {
  return labTickSafeV2();
}

// Retained only for comparison while migrating existing paper-journal data.
async function labTickLegacy() {
  if (labTickSafeRunning) return;
  labTickSafeRunning = true;
  try {
    let changed = false;
    const liveChecks = (scalpScan.results[0] && scalpScan.results[0].checks || [])
      .map(c => c.en || c.k);
    const runtime = labRuntimeStatus();
    const cohort = reconcileLabCohort(liveChecks, runtime);
    changed = changed || cohort.changed;

    for (const trade of labState.trades.filter(t => !t.closedAt)) {
      try {
        if (freezeLabExecution(trade)) {
          trade.executionInferred = true;
          changed = true;
        }
        const tickerResponse = await fetch(
          `https://api.exchange.coinbase.com/products/${trade.pair}/ticker`,
          { headers: { 'User-Agent': 'trading-app/1.0' } }
        );
        if (!tickerResponse.ok) continue;
        const ticker = await tickerResponse.json();
        const bid = parseFloat(ticker.bid || ticker.price);
        if (!(bid > 0)) continue;

        if (finiteNumber(trade.last) !== bid) {
          trade.last = bid;
          changed = true;
        }
        const gainPct = (bid - trade.entry) / trade.entry * 100;
        const mfe = Math.round(gainPct * 100) / 100;
        if (trade.mfe == null || mfe > trade.mfe) {
          trade.mfe = mfe;
          changed = true;
        }
        if (trade.mae == null || mfe < trade.mae) {
          trade.mae = mfe;
          changed = true;
        }

        const execution = labExecutionForTrade(trade);
        const targetPrice = trade.entry * (1 + execution.targetPct / 100);
        const stopPrice = trade.entry * (1 - execution.slPct / 100);
        const close = (exit, why, details = {}) => {
          const closedAt = Date.now();
          trade.exit = exit;
          trade.closedAt = closedAt;
          trade.why = why;
          trade.exitModel = execution.executionModel;
          Object.assign(trade, details);
          const pnl = labPnl(trade, exit);
          trade.pnl = pnl;
          trade.pnlPct = pnl != null && trade.budget > 0
            ? Math.round(pnl / trade.budget * 10000) / 100 : null;
          trade.holdH = Math.round((closedAt - trade.openedAt) / 3600000 * 10) / 10;
          changed = true;
          console.log(`[lab] ${trade.coin} ${why}: ${trade.pnlPct}%`);
        };

        // A target is a limit exit: once bid crosses it, target is fillable.
        if (gainPct >= execution.targetPct) {
          close(targetPrice, 'TP', { limitPrice: targetPrice, exitObservedBid: bid });
        // A stop is only a trigger in this paper model; the simulated fill is
        // the observed bid, including a gap through the intended stop price.
        } else if (execution.slPct > 0 && gainPct <= -execution.slPct) {
          close(bid, 'SL', {
            stopPrice,
            exitObservedBid: bid,
            stopSlippagePct: stopPrice > 0
              ? Math.round((bid / stopPrice - 1) * 10000) / 100 : null,
          });
        } else if ((Date.now() - trade.openedAt) / 3600000 >= execution.maxHoldH) {
          close(bid, 'TIME', { exitObservedBid: bid });
        }
      } catch (e) {
        console.warn(`[lab] ticker ${trade.coin}:`, e.message);
      }
      await sleep(120);
    }

    if (labState.enabled && cohort.entriesAllowed) {
      const results = Array.isArray(scalpScan.results) ? scalpScan.results : [];
      // This is a structural-gate experiment. tradeReady remains recorded so
      // research rows cannot be mistaken for authorised trading signals.
      const passers = results.filter(candidate => candidate.pass);
      const currentOpen = labState.trades.filter(t => !t.closedAt && isCurrentLabTrade(t));
      const openShadows = currentOpen.filter(t => t.shadow && !t.far).length;
      const openFar = currentOpen.filter(t => t.far).length;
      const nearMiss = results
        .filter(candidate => !candidate.pass && candidate.checks &&
          candidate.passed === candidate.checks.length - 1)
        .slice(0, Math.max(0, 12 - openShadows));
      const farMiss = results
        .filter(candidate => !candidate.pass && candidate.checks &&
          candidate.passed === candidate.checks.length - 2)
        .slice(0, Math.max(0, 6 - openFar));

      for (const candidate of [...passers, ...nearMiss, ...farMiss]) {
        const isShadow = !candidate.pass;
        const isFar = isShadow && candidate.passed === candidate.checks.length - 2;
        if (labState.trades.some(t => t.coin === candidate.coin && !t.closedAt)) continue;

        const recent = [...labState.trades].reverse()
          .find(t => t.coin === candidate.coin && t.closedAt);
        const cooldown = (isShadow ? 6 : 4) * 3600 * 1000;
        if (recent && Date.now() - recent.closedAt < cooldown) continue;

        const ask = await fetchBestAsk(candidate.pair);
        if (!(ask > 0)) continue;

        const failed = isShadow
          ? candidate.checks.filter(c => !c.ok).map(c => c.en || c.k) : [];
        const now = Date.now();
        const execution = currentLabExecution();
        const validation = scalpScan.validation || scalpValidationStatus();
        const candidateChecks = Array.isArray(candidate.checks)
          ? candidate.checks.map(c => ({ k: c.k || null, en: c.en || c.k || null, ok: !!c.ok }))
          : [];
        const fee = execution.feePct;
        const budget = labState.budget;
        labState.trades.push({
          id: `lab_${now}_${candidate.coin}`,
          coin: candidate.coin, pair: candidate.pair,
          entry: ask, last: ask,
          qty: budget * (1 - fee) / ask,
          budget, openedAt: now,
          shadow: isShadow, far: isFar,
          entryKind: isFar ? 'wider-control' : isShadow ? 'near-control' : 'structural-gate',
          structuralPass: !!candidate.pass, tradeReady: !!candidate.tradeReady,
          missing: failed.length ? failed.join(' + ') : null,
          cohortId: labState.cohortId,
          gateFingerprint: RUNTIME_GATE_FINGERPRINT,
          gateChecks: candidateChecks,
          gateCheckNames: liveChecks.length ? [...liveChecks] : null,
          provenance: 'runtime-captured-v2',
          validationState: validation.state || 'missing',
          validationFingerprint: validation.fingerprint || null,
          entryScanAt: scalpScan.at || null,
          entrySignalAgeSec: scalpScan.at ? Math.round((now - scalpScan.at) / 1000) : null,
          targetPct: execution.targetPct, slPct: execution.slPct,
          feePct: execution.feePct, maxHoldH: execution.maxHoldH,
          executionModel: execution.executionModel, executionCapturedAt: now,
          mfe: 0, mae: 0,
          ctx: {
            score: candidate.score, rangePos: candidate.rangePos, rsi: candidate.rsi,
            rsiMin: candidate.rsiMin != null ? candidate.rsiMin : null,
            spreadPct: candidate.spreadPct, vol24: candidate.vol24, volX: candidate.volX,
            btcDist: scalpScan.regime ? scalpScan.regime.distPct : null,
            hourUtc: new Date().getUTCHours(),
            range4Pct: candidate.range4Pct != null ? candidate.range4Pct : null,
            runUp24: candidate.runUp24 != null ? candidate.runUp24 : null,
            dropFromHigh: candidate.dropFromHigh4Pct != null ? candidate.dropFromHigh4Pct : null,
          },
        });
        changed = true;
        console.log(`[lab] ${isFar ? 'wider-control' : isShadow ? 'near-control' : 'structural-gate'} ${candidate.coin} @ $${ask}`);
      }
    }
    if (changed) saveLab();
  } catch (e) {
    console.error('[lab safe]', e.message);
  } finally {
    labTickSafeRunning = false;
  }
}
setTimeout(labTickSafe, 90_000);

let labTickSafeV2Running = false;
function currentScalpChecks() {
  return (scalpScan.results[0] && scalpScan.results[0].checks || [])
    .map(check => check.en || check.k);
}
function labScanIsFresh(scanAt, now = Date.now()) {
  const at = finiteNumber(scanAt);
  return at != null && now >= at && now - at <= LAB_MAX_SCAN_AGE_MS;
}
function markLabTimeExitPending(trade, execution, now = Date.now()) {
  const openedAt = finiteNumber(trade.openedAt);
  const dueAt = openedAt != null && execution.maxHoldH > 0
    ? openedAt + execution.maxHoldH * 3600000 : null;
  const due = dueAt != null && now >= dueAt;
  if (!due) return false;
  let changed = false;
  if (finiteNumber(trade.timeExitDueAt) == null) {
    trade.timeExitDueAt = dueAt;
    changed = true;
  }
  if (trade.exitPendingReason !== 'TIME_QUOTE_UNAVAILABLE') {
    trade.exitPendingReason = 'TIME_QUOTE_UNAVAILABLE';
    changed = true;
  }
  return changed;
}
async function labTickSafeV2() {
  if (labTickSafeV2Running) return;
  labTickSafeV2Running = true;
  try {
    let changed = false;
    const liveChecks = currentScalpChecks();
    const runtime = labRuntimeStatus();
    const cohort = reconcileLabCohort(liveChecks, runtime);
    changed = changed || cohort.changed;

    for (const trade of labState.trades.filter(item => !item.closedAt)) {
      let execution = null;
      const now = Date.now();
      const markTimePending = () => {
        if (execution && markLabTimeExitPending(trade, execution, Date.now())) changed = true;
      };
      try {
        if (freezeLabExecution(trade)) {
          trade.executionInferred = true;
          changed = true;
        }
        execution = labExecutionForTrade(trade);
        const tickerResponse = await fetch(
          'https://api.exchange.coinbase.com/products/' + trade.pair + '/ticker',
          { headers: { 'User-Agent': 'trading-app/1.0' } }
        );
        if (!tickerResponse.ok) {
          markTimePending();
          continue;
        }
        const ticker = await tickerResponse.json();
        const bid = parseFloat(ticker.bid);
        if (!(bid > 0)) {
          markTimePending();
          continue;
        }
        const observedAt = Date.now();
        if (finiteNumber(trade.last) !== bid) {
          trade.last = bid;
          changed = true;
        }
        if (finiteNumber(trade.lastBidAt) !== observedAt) {
          trade.lastBidAt = observedAt;
          changed = true;
        }
        const gainPct = (bid - trade.entry) / trade.entry * 100;
        const observedGain = Math.round(gainPct * 100) / 100;
        if (trade.mfe == null || observedGain > trade.mfe) {
          trade.mfe = observedGain;
          changed = true;
        }
        if (trade.mae == null || observedGain < trade.mae) {
          trade.mae = observedGain;
          changed = true;
        }

        const targetPrice = trade.entry * (1 + execution.targetPct / 100);
        const stopPrice = trade.entry * (1 - execution.slPct / 100);
        const close = (exit, why, details = {}) => {
          const closedAt = Date.now();
          trade.exit = exit;
          trade.closedAt = closedAt;
          trade.why = why;
          trade.exitModel = execution.executionModel;
          if (trade.exitPendingReason) delete trade.exitPendingReason;
          Object.assign(trade, details);
          const pnl = labPnl(trade, exit);
          trade.pnl = pnl;
          trade.pnlPct = pnl != null && trade.budget > 0
            ? Math.round(pnl / trade.budget * 10000) / 100 : null;
          trade.holdH = Math.round((closedAt - trade.openedAt) / 3600000 * 10) / 10;
          changed = true;
          console.log('[lab] ' + trade.coin + ' ' + why + ': ' + trade.pnlPct + '%');
        };

        // A quote first observed after the holding deadline cannot prove that a
        // target was filled before it. Close it as TIME to keep the journal
        // conservative instead of crediting an unobserved late TP.
        if (execution.maxHoldH > 0 && observedAt >= trade.openedAt + execution.maxHoldH * 3600000) {
          const timeExitDueAt = finiteNumber(trade.timeExitDueAt) ||
            (trade.openedAt + execution.maxHoldH * 3600000);
          close(bid, 'TIME', {
            exitObservedBid: bid, exitObservedBidAt: observedAt, timeExitDueAt,
            timeExitDelayMin: Math.max(0, Math.round((observedAt - timeExitDueAt) / 60000)),
          });
        } else if (gainPct >= execution.targetPct) {
          close(targetPrice, 'TP', {
            limitPrice: targetPrice, exitObservedBid: bid, exitObservedBidAt: observedAt,
          });
        } else if (execution.slPct > 0 && gainPct <= -execution.slPct) {
          close(bid, 'SL', {
            stopPrice, exitObservedBid: bid, exitObservedBidAt: observedAt,
            stopSlippagePct: stopPrice > 0
              ? Math.round((bid / stopPrice - 1) * 10000) / 100 : null,
          });
        }
      } catch (error) {
        markTimePending();
        console.warn('[lab] ticker ' + trade.coin + ':', error.message);
      }
      await sleep(120);
    }

    const scanAt = finiteNumber(scalpScan.at);
    if (labState.enabled && cohort.entriesAllowed && labScanIsFresh(scanAt)) {
      const entryCohortId = labState.cohortId;
      const results = Array.isArray(scalpScan.results) ? scalpScan.results : [];
      const passers = results.filter(candidate => candidate.pass);
      const currentOpen = labState.trades.filter(trade => !trade.closedAt && isCurrentLabTrade(trade));
      const openShadows = currentOpen.filter(trade => trade.shadow && !trade.far).length;
      const openFar = currentOpen.filter(trade => trade.far).length;
      const nearMiss = results
        .filter(candidate => !candidate.pass && candidate.checks &&
          candidate.passed === candidate.checks.length - 1)
        .slice(0, Math.max(0, 12 - openShadows));
      const farMiss = results
        .filter(candidate => !candidate.pass && candidate.checks &&
          candidate.passed === candidate.checks.length - 2)
        .slice(0, Math.max(0, 6 - openFar));

      for (const candidate of [...passers, ...nearMiss, ...farMiss]) {
        const isShadow = !candidate.pass;
        const isFar = isShadow && candidate.passed === candidate.checks.length - 2;
        const failed = isShadow
          ? candidate.checks.filter(check => !check.ok).map(check => check.en || check.k) : [];
        if (failed.includes('Spread verified and <=0.4%')) continue;
        if (labState.trades.some(trade => trade.coin === candidate.coin && !trade.closedAt)) continue;
        const recent = [...labState.trades].reverse()
          .find(trade => trade.coin === candidate.coin && trade.closedAt);
        const cooldown = (isShadow ? 6 : 4) * 3600 * 1000;
        if (recent && Date.now() - recent.closedAt < cooldown) continue;

        const quote = await fetchBestQuote(candidate.pair);
        if (!quote || quote.spreadPct > LAB_MAX_ENTRY_SPREAD_PCT) continue;

        const entryRuntime = labRuntimeStatus();
        const entryChecks = currentScalpChecks();
        const entryCohort = reconcileLabCohort(entryChecks, entryRuntime);
        changed = changed || entryCohort.changed;
        if (!labState.enabled || !entryRuntime.matched || !entryCohort.entriesAllowed ||
            labState.cohortId !== entryCohortId || finiteNumber(scalpScan.at) !== scanAt ||
            !labScanIsFresh(scanAt)) continue;

        const now = Date.now();
        const executionAtEntry = currentLabExecution();
        const validation = scalpValidationStatus();
        const burstId = labBurstIdForEntry(now, entryCohortId);
        const candidateChecks = Array.isArray(candidate.checks)
          ? candidate.checks.map(check => ({
            k: check.k || null, en: check.en || check.k || null, ok: !!check.ok,
          })) : [];
        const fee = executionAtEntry.feePct;
        const budget = labState.budget;
        const initialGain = Math.round((quote.bid - quote.ask) / quote.ask * 10000) / 100;
        labState.trades.push({
          id: 'lab_' + now + '_' + candidate.coin,
          coin: candidate.coin, pair: candidate.pair,
          entry: quote.ask, last: quote.bid, qty: budget * (1 - fee) / quote.ask,
          entryBid: quote.bid, entrySpreadPct: quote.spreadPct, entryQuoteAt: quote.at,
          scanSpreadPct: candidate.spreadPct,
          budget, openedAt: now, shadow: isShadow, far: isFar,
          entryKind: isFar ? 'wider-control' : isShadow ? 'near-control' : 'structural-gate',
          structuralPass: !!candidate.pass, tradeReady: !!(candidate.pass && validation.ready),
          missing: failed.length ? failed.join(' + ') : null,
          cohortId: labState.cohortId, gateFingerprint: RUNTIME_GATE_FINGERPRINT,
          burstId,
          gateChecks: candidateChecks, gateCheckNames: entryChecks.length ? [...entryChecks] : null,
          provenance: 'runtime-captured-v4',
          validationState: validation.state || 'missing',
          validationFingerprint: validation.fingerprint || null,
          entryScanAt: scanAt, entrySignalAgeSec: Math.round((now - scanAt) / 1000),
          targetPct: executionAtEntry.targetPct, slPct: executionAtEntry.slPct,
          feePct: executionAtEntry.feePct, maxHoldH: executionAtEntry.maxHoldH,
          executionModel: executionAtEntry.executionModel, executionCapturedAt: now,
          mfe: initialGain, mae: initialGain,
          ctx: {
            score: candidate.score, rangePos: candidate.rangePos, rsi: candidate.rsi,
            rsiMin: candidate.rsiMin != null ? candidate.rsiMin : null,
            spreadPct: quote.spreadPct, scanSpreadPct: candidate.spreadPct,
            vol24: candidate.vol24, volX: candidate.volX,
            btcDist: scalpScan.regime ? scalpScan.regime.distPct : null,
            hourUtc: new Date().getUTCHours(),
            range4Pct: candidate.range4Pct != null ? candidate.range4Pct : null,
            runUp24: candidate.runUp24 != null ? candidate.runUp24 : null,
            dropFromHigh: candidate.dropFromHigh4Pct != null ? candidate.dropFromHigh4Pct : null,
          },
        });
        changed = true;
        console.log('[lab] ' + (isFar ? 'wider-control' : isShadow ? 'near-control' : 'structural-gate') +
          ' ' + candidate.coin + ' @ $' + quote.ask + ' (spread ' + quote.spreadPct + '%)');
      }
    }
    if (changed) saveLab();
  } catch (error) {
    console.error('[lab safe]', error.message);
  } finally {
    labTickSafeV2Running = false;
  }
}


app.get('/api/lab', (req, res) => {
  return sendSafeLabApi(req, res);
  // Контрольная группа считается отдельно: она нужна для проверки условий,
  // а не для оценки самого гейта
  const closedAll = labState.trades.filter(t => t.closedAt);
  const closed = closedAll.filter(t => !t.shadow);
  // Контроль «не хватило одного» и разведка «не хватило двух» — разные вопросы,
  // и смешивать их нельзя: во второй группе ключ составной, и проверка условий
  // приняла бы пару условий за одно
  const shadows = closedAll.filter(t => t.shadow && !t.far);
  const farShadows = closedAll.filter(t => t.far);
  const currentClosed = closed.filter(t => t.gen !== 'old');
  const staleClosed = closed.filter(t => t.gen === 'old');
  const currentShadows = shadows.filter(t => t.gen !== 'old');
  const currentFarShadows = farShadows.filter(t => t.gen !== 'old');
  const open = labState.trades.filter(t => !t.closedAt).map(t => ({
    ...t, pnlPct: t.last ? Math.round(((t.last / t.entry - 1) * 100 - paperLimitFee() * 200) * 100) / 100 : null,
  }));
  const currentOpen = open.filter(t => t.gen !== 'old');
  const since = labState.startedAt ? Math.round((Date.now() - labState.startedAt) / 3600000) : 0;
  const { base, observations, enough } = lab.findObservations(currentClosed);
  const conditions = lab.checkConditions(currentClosed, currentShadows);
  const historical = loadGateValidation(labState.fingerprint);
  res.json({
    success: true,
    enabled: labState.enabled, startedAt: labState.startedAt, hoursRunning: since,
    budget: labState.budget,
    open, currentOpenCount: currentOpen.length, staleOpenCount: open.length - currentOpen.length,
    closedCount: closed.length, currentClosedCount: currentClosed.length, staleClosedCount: staleClosed.length,
    shadowCount: shadows.length, currentShadowCount: currentShadows.length,
    farCount: farShadows.length, currentFarCount: currentFarShadows.length,
    closed: closed.slice(-40).reverse(),
    stats: base, allStats: lab.agg(closed), observations, enough, conditions,
    historical,
    generations: (labState.generations || []).slice(-10).reverse(),
    fingerprint: labState.fingerprint,
    brief: lab.buildBrief(currentClosed, {
      since: since ? `${since}h` : null,
      generations: labState.generations || [],
      conditions,
      // Условия снимаем с работающего сканера — задание всегда описывает
      // ту версию алгоритма, которая реально крутится
      liveChecks: (scalpScan.results[0] && scalpScan.results[0].checks || []).map(c => c.en || c.k),
      fingerprint: labState.fingerprint,
      // Сколько из закрытых открылись ещё при прошлом поколении
      staleCount: staleClosed.length,
      historical,
      archivedStats: lab.agg(staleClosed),
      // Пик/дно и причины выхода — по ним задание считает, что дала бы другая
      // цель и другой стоп, не запуская новый бэктест
      exits: currentClosed.map(t => ({ why: t.why, mfe: t.mfe, mae: t.mae, pnlPct: t.pnlPct, holdH: t.holdH })),
      farGroup: lab.aggFar(currentFarShadows),
      // Что сейчас в полёте: пока ничего не закрылось, задание должно
      // показывать работу, а не пустую строку «сделок нет»
      openNow: (() => {
        if (!currentOpen.length) return null;
        const hrs = currentOpen.map(t => (Date.now() - t.openedAt) / 3600000);
        const mfes = currentOpen.map(t => t.mfe).filter(Number.isFinite);
        const maes = currentOpen.map(t => t.mae).filter(Number.isFinite);
        const cl = lab.clusters(currentOpen);
        return {
          n: currentOpen.length,
          gate: currentOpen.filter(t => !t.shadow).length,
          shadow: currentOpen.filter(t => t.shadow && !t.far).length,
          far: currentOpen.filter(t => t.far).length,
          up: currentOpen.filter(t => t.pnlPct > 0).length,
          oldestH: Math.round(Math.max(...hrs) * 10) / 10,
          youngestH: Math.round(Math.min(...hrs) * 10) / 10,
          bestMfe: mfes.length ? Math.max(...mfes) : null,
          worstMae: maes.length ? Math.min(...maes) : null,
          clusters: cl.length,
          biggest: cl.length ? Math.max(...cl.map(c => c.length)) : 0,
        };
      })(),
      targetPct: paperTargetPct(),
      slPct: paperBot.slPct != null ? paperBot.slPct : PAPER_CFG.slPct,
      feePct: paperLimitFee() * 2,
    }),
  });
});

app.post('/api/lab/config', (req, res) => {
  return updateSafeLabConfig(req, res);
  const { enabled } = req.body || {};
  if (enabled !== undefined) {
    const on = !!enabled;
    if (on && !labState.enabled) labState.startedAt = labState.startedAt || Date.now();
    labState.enabled = on;
  }
  // budget больше не принимается: сумма зафиксирована в LAB_BUDGET
  saveLab();
  res.json({ success: true, enabled: labState.enabled, budget: labState.budget });
});

app.delete('/api/lab/trades', (req, res) => {
  return clearSafeLabTrades(req, res);
  labState.trades = [];
  labState.startedAt = labState.enabled ? Date.now() : 0;
  saveLab();
  res.json({ success: true });
});

// Правки внедрены → фиксируем поколение. Накопленные сделки уходят в архив
// вместе с наблюдениями, сбор начинается заново. Иначе следующее задание
// повторяло бы то, что уже сделано, на старых данных.
app.post('/api/lab/applied', (req, res) => {
  return recordSafeLabApplied(req, res);
  let note = String((req.body || {}).note || '').slice(0, 2000);
  // Не записываем заведомо битый текст: одна такая заметка уже осела в архиве
  // и с тех пор показывалась в каждом задании
  if (isMojibake(note)) {
    return res.status(400).json({
      success: false,
      error: 'Note arrived garbled — the text lost its encoding in transit. Send it as UTF-8, in English.',
    });
  }
  const closed = labState.trades.filter(t => t.closedAt);
  const { base, observations } = lab.findObservations(closed);
  labState.generations = labState.generations || [];
  labState.generations.push({
    at: Date.now(),
    note,
    trades: closed.length,
    stats: base,
    observations: (observations || []).slice(0, 10),
  });
  labState.generations = labState.generations.slice(-20);
  // Открытые оставляем: они ещё не завершились, но они уже по старой версии —
  // помечаем, чтобы не смешивать поколения в статистике
  labState.trades = labState.trades.filter(t => !t.closedAt).map(t => ({ ...t, gen: 'old' }));
  labState.startedAt = Date.now();
  saveLab();
  console.log(`[lab] зафиксировано поколение #${labState.generations.length}: ${closed.length} сделок`);
  res.json({ success: true, generation: labState.generations.length });
});

// ── Одноразовый Telegram-алерт по scalp-гейту (отдельная кнопка) ──
const SCALP_WATCH_FILE = path.join(__dirname, 'scalp-watch.json');

// API helpers for the safe journal loop. All current statistics are scoped to
// an explicit cohort; older and legacy rows remain available only as archive.
function labApiPayload() {
  const runtime = labRuntimeStatus();
  const scannerChecks = (scalpScan.results[0] && scalpScan.results[0].checks || [])
    .map(check => check.en || check.k);
  const reconciliation = reconcileLabCohort(scannerChecks, runtime);
  if (reconciliation.changed) saveLab();
  const current = trade => isCurrentLabTrade(trade);
  const closedAll = labState.trades.filter(trade => trade.closedAt);
  const closedGate = closedAll.filter(trade => !trade.shadow);
  const shadows = closedAll.filter(trade => trade.shadow && !trade.far);
  const farShadows = closedAll.filter(trade => trade.far);
  const currentClosed = closedGate.filter(current);
  const staleClosed = closedGate.filter(trade => !current(trade));
  const currentShadows = shadows.filter(current);
  const currentFarShadows = farShadows.filter(current);
  const open = labState.trades.filter(trade => !trade.closedAt).map(trade => {
    const pnl = finiteNumber(trade.last) != null ? labPnl(trade, trade.last) : null;
    return {
      ...trade,
      pnl,
      pnlPct: pnl != null && trade.budget > 0
        ? Math.round(pnl / trade.budget * 10000) / 100 : null,
      isCurrent: current(trade),
    };
  });
  const currentOpen = open.filter(trade => trade.isCurrent);
  const staleOpen = open.filter(trade => !trade.isCurrent);
  const since = labState.startedAt
    ? Math.round((Date.now() - labState.startedAt) / 3600000) : 0;
  const analysis = lab.findObservations(currentClosed);
  const conditions = lab.checkConditions(currentClosed, currentShadows);
  const historical = runtime.matched
    ? loadGateValidation(runtime.runtimeFingerprint) : null;
  const liveChecks = (scalpScan.results[0] && scalpScan.results[0].checks || [])
    .map(check => check.en || check.k);

  return {
    success: true,
    enabled: labState.enabled,
    entryBlocked: !runtime.matched,
    runtime,
    cohort: {
      id: labState.cohortId || null,
      fingerprint: labState.fingerprint || null,
      checks: labState.gateSnapshot || null,
    },
    execution: currentLabExecution(),
    startedAt: labState.startedAt,
    hoursRunning: since,
    budget: labState.budget,
    open,
    currentOpen,
    currentOpenCount: currentOpen.length,
    staleOpenCount: staleOpen.length,
    closedCount: closedGate.length,
    currentClosedCount: currentClosed.length,
    staleClosedCount: staleClosed.length,
    shadowCount: shadows.length,
    currentShadowCount: currentShadows.length,
    farCount: farShadows.length,
    currentFarCount: currentFarShadows.length,
    closed: currentClosed.slice(-40).reverse(),
    archivedClosed: staleClosed.slice(-40).reverse(),
    stats: analysis.base,
    allStats: lab.agg(currentClosed),
    archivedStats: lab.agg(staleClosed),
    observations: analysis.observations,
    enough: analysis.enough,
    conditions,
    historical,
    generations: (labState.generations || []).slice(-10).reverse(),
    fingerprint: runtime.runtimeFingerprint || null,
    diskFingerprint: runtime.diskFingerprint || null,
    brief: lab.buildBrief(currentClosed, {
      since: since ? since + 'h' : null,
      generations: labState.generations || [],
      conditions,
      liveChecks,
      fingerprint: runtime.runtimeFingerprint || null,
      staleCount: staleClosed.length,
      historical,
      // Причину несовпадения задание печатает словами: «прогона нет» и
      // «прогон про другой эксперимент» лечатся по-разному.
      validationWhy: (scalpScan.validation || scalpValidationStatus()).why || null,
      validationDetail: (scalpScan.validation || scalpValidationStatus()).detailEn || null,
      archivedStats: lab.agg(staleClosed),
      runtime,
      cohortId: labState.cohortId || null,
      exits: currentClosed.map(trade => ({
        why: trade.why, mfe: trade.mfe, mae: trade.mae,
        pnlPct: trade.pnlPct, holdH: trade.holdH,
      })),
      farGroup: lab.aggFar(currentFarShadows),
      openNow: (() => {
        if (!currentOpen.length) return null;
        const hours = currentOpen.map(trade => (Date.now() - trade.openedAt) / 3600000);
        const mfes = currentOpen.map(trade => trade.mfe).filter(Number.isFinite);
        const maes = currentOpen.map(trade => trade.mae).filter(Number.isFinite);
        const clusters = lab.clusters(currentOpen);
        return {
          n: currentOpen.length,
          gate: currentOpen.filter(trade => !trade.shadow).length,
          shadow: currentOpen.filter(trade => trade.shadow && !trade.far).length,
          far: currentOpen.filter(trade => trade.far).length,
          up: currentOpen.filter(trade => trade.pnlPct > 0).length,
          oldestH: Math.round(Math.max(...hours) * 10) / 10,
          youngestH: Math.round(Math.min(...hours) * 10) / 10,
          bestMfe: mfes.length ? Math.max(...mfes) : null,
          worstMae: maes.length ? Math.min(...maes) : null,
          clusters: clusters.length,
          biggest: clusters.length ? Math.max(...clusters.map(cluster => cluster.length)) : 0,
        };
      })(),
      targetPct: currentLabExecution().targetPct,
      slPct: currentLabExecution().slPct,
      feePct: currentLabExecution().feePct * 2,
    }),
  };
}
function sendSafeLabApi(req, res) {
  res.json(labApiPayload());
}
function microScalpBrief(payload) {
  const execution = payload.execution || {};
  const stats = payload.stats || {};
  const review = microScalpReview(payload);
  const checks = (microScalpScan.results[0] && microScalpScan.results[0].checks || [])
    .map(check => check.k).filter(Boolean);
  const formatPct = value => Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value}%` : 'n/a';
  const recent = (payload.closed || []).slice(0, 30).map(trade => {
    const context = trade.ctx || {};
    const details = [
      context.rsi != null ? `rsi=${context.rsi}` : null,
      context.pullbackPct != null ? `pullback=${context.pullbackPct}%` : null,
      context.volumeX != null ? `volume=${context.volumeX}x` : null,
      context.spreadPct != null ? `spread=${context.spreadPct}%` : null,
    ].filter(Boolean).join(', ');
    return `- ${trade.pair || trade.coin}: ${trade.why || 'CLOSED'}, ${formatPct(trade.pnlPct)}, hold ${trade.holdMin ?? 'n/a'} min${details ? ` (${details})` : ''}`;
  });
  const open = (payload.open || []).map(trade =>
    `- ${trade.pair || trade.coin}: OPEN, ${formatPct(trade.pnlPct)}, age ${Math.max(0, Math.round((Date.now() - trade.openedAt) / 60000))} min`
  );
  return [
    '## B. FAST SCALP PAPER LAB (15–60 MINUTES)',
    'This is a separate paper-only experiment. It never places real orders. Do not mix its evidence, thresholds, or conclusions with the 2–6 hour scalp gate.',
    `Cohort fingerprint: ${payload.cohort && payload.cohort.fingerprint || 'unknown'}; state: ${payload.entryBlocked ? 'ENTRY BLOCKED' : 'collecting'}; running: ${payload.hoursRunning ?? 'n/a'}h.`,
    `Execution: target +${execution.targetPct ?? 'n/a'}%, stop -${execution.slPct ?? 'n/a'}%, time limit ${execution.maxHoldMin ?? 'n/a'} min, limit fee ${Number.isFinite(execution.feePct) ? Math.round(execution.feePct * 1e5) / 1e3 : 'n/a'}%.`,
    `Current cohort: ${payload.currentClosedCount || 0} closed, ${payload.currentOpenCount || 0} open, ${payload.bursts || 0} independent bursts.`,
    `Decision sample: ${review.closedBursts}/${review.minClosedBursts} independent closed bursts${review.ready ? ' (threshold reached).' : `; ${review.remainingBursts} more required before changing the experiment.`}`,
    `Statistics: wins ${stats.winRate == null ? 'n/a' : stats.winRate + '%'}; average ${formatPct(stats.avgPct)}; total $${stats.totalPnl == null ? 'n/a' : stats.totalPnl}; average hold ${stats.avgHoldMin == null ? 'n/a' : stats.avgHoldMin + ' min'}.`,
    checks.length ? `All required current conditions: ${checks.join('; ')}.` : 'Current scan conditions are not available yet.',
    open.length ? `Open positions:\n${open.join('\n')}` : 'Open positions: none.',
    recent.length ? `Recent closed positions:\n${recent.join('\n')}` : 'Recent closed positions: none.',
    review.ready
      ? 'The minimum independent sample is complete. Review the full cohort before deciding whether to change this experiment.'
      : 'Do not change this experiment until the stated number of independent, closed bursts is reached.',
  ].join('\n');
}
function combinedScalpBrief() {
  const structural = labApiPayload();
  const fast = microScalpLab.payload();
  return [
    '# Task: review two independent paper scalp experiments',
    'Keep the two sections completely separate. Do not transfer a threshold, score rule, or performance conclusion from one strategy to the other.',
    '',
    '## A. STRUCTURAL SCALP GATE (2–6 HOURS)',
    structural.brief || 'Structural scalp journal is not available yet.',
    '',
    microScalpBrief(fast),
  ].join('\n');
}
app.get('/api/lab/combined-brief', (req, res) => {
  res.json({ success: true, brief: combinedScalpBrief() });
});
function updateSafeLabConfig(req, res) {
  const body = req.body || {};
  if (body.enabled !== undefined) {
    const enabled = !!body.enabled;
    if (enabled && !labState.enabled) labState.startedAt = labState.startedAt || Date.now();
    labState.enabled = enabled;
  }
  saveLab();
  const runtime = labRuntimeStatus();
  res.json({
    success: true,
    enabled: labState.enabled,
    budget: labState.budget,
    entryBlocked: !runtime.matched,
    runtime,
  });
}
function clearSafeLabTrades(req, res) {
  const runtime = labRuntimeStatus();
  const checks = (scalpScan.results[0] && scalpScan.results[0].checks || [])
    .map(check => check.en || check.k);
  labState.trades = [];
  const execution = currentLabExecution();
  labState.cohortId = makeExecutionAwareCohortId(runtime.runtimeFingerprint, Date.now(), execution);
  labState.executionFingerprint = labExecutionFingerprint(execution);
  labState.executionSnapshot = snapshotLabExecution(execution);
  labState.fingerprint = runtime.runtimeFingerprint || null;
  labState.gateSnapshot = checks.length ? checks : null;
  labState.startedAt = labState.enabled ? Date.now() : 0;
  saveLab();
  res.json({ success: true });
}
function recordSafeLabApplied(req, res) {
  let note = String((req.body || {}).note || '').slice(0, 2000);
  if (isMojibake(note)) {
    return res.status(400).json({
      success: false,
      error: 'Note arrived garbled. Send it as UTF-8, in English.',
    });
  }
  const runtime = labRuntimeStatus();
  if (!runtime.matched) {
    return res.status(409).json({
      success: false,
      error: 'Restart required: source gate differs from the loaded scanner.',
      runtime,
    });
  }
  const checks = (scalpScan.results[0] && scalpScan.results[0].checks || [])
    .map(check => check.en || check.k);
  archiveCurrentLabCohort(
    'manual application acknowledged',
    runtime.runtimeFingerprint,
    checks,
    note || 'Manual application acknowledged; prior cohort archived for audit.'
  );
  saveLab();
  res.json({
    success: true,
    generation: (labState.generations || []).length,
    cohortId: labState.cohortId,
  });
}
let scalpWatchArmed = false;
// Непрерывный режим: шлёт по каждому новому входу, пока не выключишь.
// scalpSent — по какой монете и по какой цене уже сообщали. Повторный
// сигнал по той же монете выдаём только после того, как она реально
// подешевела и снова прошла гейт: иначе монета, болтающаяся на границе
// условий, слала бы сообщение каждую минуту.
let scalpLoopOn = false;
let scalpSent = {};              // coin -> { price, at, fell }
const SCALP_REARM_DROP = 1.0;    // на сколько % должна упасть, чтобы считаться новым случаем
try {
  const st = JSON.parse(fs.readFileSync(SCALP_WATCH_FILE, 'utf8'));
  scalpWatchArmed = !!st.armed;
  scalpLoopOn = !!st.loop;
  scalpSent = st.sent && typeof st.sent === 'object' ? st.sent : {};
} catch { }
function saveScalpWatch() {
  try {
    fs.writeFileSync(SCALP_WATCH_FILE, JSON.stringify({
      armed: scalpWatchArmed, loop: scalpLoopOn, sent: scalpSent,
    }));
  } catch { }
}
function tgConfigured() {
  const s = loadSettings();
  return !!(s.telegramToken && s.telegramChat);
}

app.post('/api/scalp-watch', (req, res) => {
  const enable = !!(req.body || {}).enable;
  if (enable && !tgConfigured()) return res.json({ success: false, error: 'Telegram не настроен: укажи Bot Token и Chat ID в настройках' });
  scalpWatchArmed = enable;
  saveScalpWatch();
  res.json({ success: true, armed: scalpWatchArmed });
});

app.post('/api/scalp-watch-loop', (req, res) => {
  const enable = !!(req.body || {}).enable;
  if (enable && !tgConfigured()) return res.json({ success: false, error: 'Telegram не настроен: укажи Bot Token и Chat ID в настройках' });
  scalpLoopOn = enable;
  // При включении начинаем с чистого листа: иначе монеты из прошлого
  // сеанса молчали бы до падения без всякой причины.
  if (enable) scalpSent = {};
  saveScalpWatch();
  res.json({ success: true, loop: scalpLoopOn });
});

app.post('/api/micro-scalp-watch', (req, res) => {
  const enable = !!(req.body || {}).enable;
  if (enable && !tgConfigured()) {
    return res.json({ success: false, error: 'Telegram не настроен: укажи Bot Token и Chat ID в настройках' });
  }
  microScalpWatchArmed = enable;
  saveMicroScalpWatch();
  res.json({ success: true, armed: microScalpWatchArmed, paperOnly: true });
});

app.post('/api/micro-scalp-watch-loop', (req, res) => {
  const enable = !!(req.body || {}).enable;
  if (enable && !tgConfigured()) {
    return res.json({ success: false, error: 'Telegram не настроен: укажи Bot Token и Chat ID в настройках' });
  }
  microScalpLoopOn = enable;
  // Новый сеанс не наследует уже отправленные сигналы из прошлого сеанса.
  if (enable) microScalpSent = {};
  saveMicroScalpWatch();
  res.json({ success: true, loop: microScalpLoopOn, paperOnly: true });
});

const NL = String.fromCharCode(10);

function microScalpAlertPool() {
  const at = Number(microScalpScan.at);
  const age = Date.now() - at;
  if (!Number.isFinite(at) || !Number.isFinite(age) || age < 0 || age > MICRO_SCALP_MAX_SCAN_AGE_MS) return [];
  const best = new Map();
  for (const row of microScalpScan.results) {
    if (!row || !row.pass || !row.coin) continue;
    if (!best.has(row.coin) || best.get(row.coin).score < row.score) best.set(row.coin, row);
  }
  return [...best.values()].sort((left, right) => right.score - left.score || left.coin.localeCompare(right.coin));
}

function microScalpAlertText(candidate) {
  const checks = Array.isArray(candidate.checks) ? candidate.checks : [];
  return '⚡ <b>БЫСТРЫЙ СКАЛЬП · 15–60 МИН · PAPER</b> — <b>' + escTg(candidate.pair) + '</b>' + NL +
    'Рейтинг <b>' + candidate.score + '/100</b> · все условия Paper-сетапа выполнены' + NL +
    '━━━━━━━━━━━━━━━━━━' + NL +
    checks.map(check => (check.ok ? '✅ ' : '❌ ') + escTg(check.k) + ': ' + escTg(check.v)).join(NL) + NL +
    '💵 Цена: $' + fmtPxAe(candidate.price) +
    (candidate.spreadPct != null ? ' · спред ' + candidate.spreadPct + '%' : '') +
    (candidate.vol24 ? ' · объём $' + Math.round(candidate.vol24 / 1e3) + 'K' : '') + NL + NL +
    '<i>Исследовательский Paper-сетап: цель +1%, стоп −1%, максимум 60 минут.' + NL +
    'Реальный ордер не выставлен; это не команда на покупку.</i>';
}

function microScalpLoopText(list, total) {
  const head = list.length === 1
    ? '⚡ <b>БЫСТРЫЙ СКАЛЬП · 15–60 МИН · PAPER</b> — <b>' + escTg(list[0].pair) + '</b>'
    : '⚡ <b>БЫСТРЫЙ СКАЛЬП · 15–60 МИН · PAPER: сетапов ' + list.length + '</b>';
  const rows = list.map(candidate => {
    const again = microScalpSent[candidate.coin] ? ' <i>(повторно после отката)</i>' : '';
    return '<b>' + escTg(candidate.pair) + '</b> — <b>' + candidate.score + '/100</b>' + again + NL +
      '   $' + fmtPxAe(candidate.price) +
      (candidate.spreadPct != null ? ' · спред ' + candidate.spreadPct + '%' : '') +
      (candidate.pullbackPct != null ? ' · откат ' + candidate.pullbackPct + '%' : '');
  }).join(NL);
  const more = total > list.length ? NL + '<i>…и ещё ' + (total - list.length) + '</i>' : '';
  return head + NL + '━━━━━━━━━━━━━━━━━━' + NL + rows + more + NL + NL +
    '<i>Paper-исследование: цель +1%, стоп −1%, максимум 60 минут.' + NL +
    'Реальные ордера не выставляются; это не команда на покупку.</i>';
}

// Общий сбор кандидатов для обоих режимов алерта
function scalpAlertPool() {
  const validation = scalpValidationStatus();
  scalpScan.validation = validation;
  if (!validation.ready) return [];
  const scanAge = Date.now() - finiteNumber(scalpScan.at);
  if (!Number.isFinite(scanAge) || scanAge < 0 || scanAge > LAB_MAX_SCAN_AGE_MS) return [];
  const pool = scalpScan.results.filter(r => r.pass);
  const best = new Map();
  for (const r of pool) if (!best.has(r.coin) || best.get(r.coin).score < r.score) best.set(r.coin, r);
  return [...best.values()].sort((a, b) => b.score - a.score);
}

// ── Непрерывный режим ──────────────────────────────────────────────
// Гейт срабатывает пачками (замерено: 12 входов за 1.2 часа), поэтому шлём
// ОДНО сообщение на проход со списком новых монет, а не двенадцать подряд:
// иначе и Telegram упрётся в лимит, и читать это невозможно.
setInterval(async () => {
  if (!scalpLoopOn) return;
  try {
    const now = Date.now();
    // Перезарядка: следим за ценой ВСЕХ монет скана, а не только прошедших.
    // Монета снова становится новым случаем, когда подешевела к цене прошлого
    // сигнала минимум на SCALP_REARM_DROP процентов.
    for (const r of scalpScan.results) {
      const seen = scalpSent[r.coin];
      if (seen && r.price > 0 && r.price <= seen.price * (1 - SCALP_REARM_DROP / 100)) seen.fell = true;
    }
    for (const k of Object.keys(scalpSent)) {
      if (now - scalpSent[k].at > 24 * 3600 * 1000) delete scalpSent[k];
    }

    const fresh = scalpAlertPool().filter(c => {
      const seen = scalpSent[c.coin];
      return !seen || seen.fell;
    });
    if (!fresh.length) return;

    const list = fresh.slice(0, 8);
    const head = list.length === 1
      ? '\u26a1 <b>СКАЛЬП · 2–6 ЧАСОВ · ВХОД</b> — <b>' + escTg(list[0].pair) + '</b>'
      : '\u26a1 <b>СКАЛЬП · 2–6 ЧАСОВ: входов ' + list.length + '</b>';
    const body = list.map(c => {
      const again = scalpSent[c.coin] ? ' <i>(повторно, после падения)</i>' : '';
      return '<b>' + escTg(c.pair) + '</b> — <b>' + c.score + '/100</b>' + again + NL +
        '   $' + fmtPxAe(c.price) +
        (c.spreadPct != null ? ' · спред ' + c.spreadPct + '%' : '') +
        (c.vol24 ? ' · объём $' + Math.round(c.vol24 / 1e3) + 'K' : '');
    }).join(NL);
    const more = fresh.length > list.length ? NL + '<i>…и ещё ' + (fresh.length - list.length) + '</i>' : '';
    const sent = await sendTelegram(
      head + NL + '━━━━━━━━━━━━━━━━━━' + NL + body + more + NL + NL +
      '<i>Непрерывный режим. По одной монете повторное сообщение придёт' + NL +
      'только после падения не менее чем на ' + SCALP_REARM_DROP + '% и нового прохода гейта.' + NL +
      'Горизонт 2–6 часов, вход лимиткой.</i>', 'HTML');
    if (!sent) { console.error('[scalp-loop] отправка не удалась, состояние не меняем'); return; }
    for (const c of list) scalpSent[c.coin] = { price: c.price, at: now, fell: false };
    saveScalpWatch();
    console.log('[scalp-loop] отправлено ' + list.length + ': ' + list.map(c => c.coin + '/' + c.score).join(' '));
  } catch (e) { console.error('[scalp-loop]', e.message); }
}, 60_000);

setInterval(async () => {
  if (!scalpWatchArmed) return;
  try {
    // Ищем по всему рынку, а не только в Top Losers — гейт к ним не привязан
    const ranked = scalpAlertPool();
    if (!ranked.length) return;
    const c = ranked[0];
    // Берём тот же объект, что и пул. Раньше в текст подставлялся
    // scalpScan.validation напрямую, а до первого скана он null — обращение
    // к .n роняло обработчик в catch, и алерт молча не уходил.
    const vld = scalpScan.validation || scalpValidationStatus();
    const sent = await sendTelegram(
      `⚡ <b>СКАЛЬП · 2–6 ЧАСОВ · ВХОД</b> — <b>${escTg(c.pair)}</b>\n` +
      `Рейтинг <b>${c.score}/100</b> · гейт пройден · горизонт 2–6 часов\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      c.checks.map(x => `${x.ok ? '✅' : '❌'} ${escTg(x.k)}: ${escTg(x.v)}`).join('\n') + '\n' +
      `💵 Цена: $${fmtPxAe(c.price)}` + (c.spreadPct != null ? ` · спред ${c.spreadPct}%` : '') +
      (c.vol24 ? ` · объём $${Math.round(c.vol24 / 1e3)}K` : '') + '\n\n' +
      `<i>Текущая версия прошла историческую проверку: n=${vld.n}, ${vld.avgPct >= 0 ? '+' : ''}${vld.avgPct}% на сделку, PF ${vld.profitFactor}.\n` +
      `Структурные условия и режим BTC выполнены. Вход лимиткой.</i>\n` +
      `<i>Проверка не гарантирует результат отдельной сделки.</i>\n` +
      `(одноразовый алерт — выключен)`, 'HTML');
    // Снимаем ТОЛЬКО если сообщение действительно ушло. Раньше алерт
    // выключался при любом исходе, и отказ Telegram выглядел так, будто
    // сигнала просто не было.
    if (!sent) {
      console.error('[scalp-watch] ' + c.pair + ' score=' + c.score + ': отправка не удалась, алерт остаётся включённым');
      return;
    }
    scalpWatchArmed = false;
    saveScalpWatch();
    console.log(`[scalp-watch] сработал ${c.pair}, score=${c.score}, telegram=ok`);
  } catch (e) { console.error('[scalp-watch]', e.message); }
}, 60_000);

// Быстрый скальп — самостоятельная Paper-лаборатория. Он использует свой
// журнал и свои настройки алертов, поэтому не влияет на 2–6-часовой гейт.
setInterval(async () => {
  if (!microScalpLoopOn) return;
  try {
    const now = Date.now();
    let changed = false;
    for (const row of microScalpScan.results) {
      const seen = row && microScalpSent[row.coin];
      if (seen && row.price > 0 && row.price <= seen.price * (1 - MICRO_SCALP_REARM_DROP / 100) && !seen.fell) {
        seen.fell = true;
        changed = true;
      }
    }
    for (const coin of Object.keys(microScalpSent)) {
      const sentAt = Number(microScalpSent[coin].at);
      if (!Number.isFinite(sentAt) || now - sentAt > 24 * 3600 * 1000) {
        delete microScalpSent[coin];
        changed = true;
      }
    }
    const fresh = microScalpAlertPool().filter(candidate => {
      const seen = microScalpSent[candidate.coin];
      return !seen || seen.fell;
    });
    if (!fresh.length) {
      if (changed) saveMicroScalpWatch();
      return;
    }
    const list = fresh.slice(0, 3);
    const sent = await sendTelegram(microScalpLoopText(list, fresh.length), 'HTML');
    if (!sent) {
      console.error('[micro-scalp-loop] Telegram delivery failed; state not advanced');
      if (changed) saveMicroScalpWatch();
      return;
    }
    for (const candidate of list) microScalpSent[candidate.coin] = { price: candidate.price, at: now, fell: false };
    saveMicroScalpWatch();
    console.log('[micro-scalp-loop] sent ' + list.length + ': ' + list.map(candidate => candidate.coin).join(' '));
  } catch (error) { console.error('[micro-scalp-loop]', error.message); }
}, 60_000);

setInterval(async () => {
  if (!microScalpWatchArmed) return;
  try {
    const candidate = microScalpAlertPool()[0];
    if (!candidate) return;
    const sent = await sendTelegram(
      microScalpAlertText(candidate) + NL + '(одноразовый Paper-алерт — выключен)', 'HTML'
    );
    if (!sent) {
      console.error('[micro-scalp-watch] ' + candidate.pair + ': Telegram delivery failed; alert remains armed');
      return;
    }
    microScalpWatchArmed = false;
    saveMicroScalpWatch();
    console.log('[micro-scalp-watch] sent ' + candidate.pair + ', paperOnly=true');
  } catch (error) { console.error('[micro-scalp-watch]', error.message); }
}, 60_000);

// ══════════════════════════════════════════════════════════════════
// ═══ СОВЕТНИК: Claude Code CLI по подписке ═══
// ══════════════════════════════════════════════════════════════════
//
// Зовём установленный на сервере `claude -p`. Ключей нигде не храним:
// авторизация — это сессия подписки, созданная один раз через `claude login`.
//
// ANTHROPIC_API_KEY из окружения дочернего процесса ВЫРЕЗАЕМ намеренно: если
// переменная где-то появится, CLI молча переключится на потокенную оплату, и
// узнали бы мы об этом по счёту, а не по поведению.
const { spawn } = require('child_process');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// Opus думает дольше Sonnet: на разбор позиции уходит до полуминуты. Прежние
// 25 секунд рубили ответ на полуслове, и окно показывало ноль разборов.
const CLAUDE_TIMEOUT_MS = 45_000;
// Окно обновляет совет раз в 20 секунд, поэтому минутный кеш возвращал бы
// устаревший вердикт три раза подряд. Держим короче цикла обновления, но
// достаточно, чтобы повторное открытие окна не тратило квоту заново.
const CLAUDE_CACHE_MS = 15_000;
let claudeInFlight = 0;              // одновременно пускаем только один вызов
const claudeAdviceCache = new Map(); // coin -> { at, data }
let claudeStatusCache = { at: 0, data: null };

// Модель для всех разборов. Opus: решение денежное, и разница между
// моделями тут стоит дороже, чем лишние секунды ожидания.
const CLAUDE_MODEL = 'opus';

function runClaude(prompt, { timeoutMs = CLAUDE_TIMEOUT_MS, args = [] } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;      // только подписка, см. выше
    delete env.ANTHROPIC_AUTH_TOKEN;
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        // Пустой каталог: CLI не должен видеть ни репозиторий, ни CLAUDE.md —
        // и контекст меньше, и читать ему тут нечего.
        cwd: os.tmpdir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,                  // аргументы массивом: подстановки нет
      });
    } catch (e) {
      return resolve({ ok: false, error: 'не удалось запустить claude: ' + e.message });
    }
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { }
      // Хвост вывода кладём в ошибку: без него «не ответил» скрывает причину,
      // а чаще всего это ожидание входа — CLI спрашивает авторизацию и ждёт.
      const tail = (err || out).trim().slice(-300);
      // Пустой вывод при таймауте — это не «долго считает». Работающий CLI
      // хоть что-то пишет; молчание означает, что он ждёт авторизации,
      // которой в фоновом процессе никто не даст.
      finish({
        ok: false,
        error: tail
          ? `claude не ответил за ${Math.round(timeoutMs / 1000)}с: ${tail}`
          : 'Claude Code на сервере не авторизован: зайди по SSH и выполни `claude login`',
        timedOut: true, tail, likelyUnauthorized: !tail,
      });
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: e.code === 'ENOENT' ? 'claude не установлен на сервере' : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish({ ok: false, error: (err.trim() || `claude вышел с кодом ${code}`).slice(0, 300) });
      finish({ ok: true, stdout: out });
    });
    if (prompt != null) { try { child.stdin.write(prompt); } catch { } }
    try { child.stdin.end(); } catch { }
  });
}

async function claudeStatus(force) {
  const now = Date.now();
  if (!force && claudeStatusCache.data && now - claudeStatusCache.at < 30_000) return claudeStatusCache.data;
  const r = await runClaude(null, { args: ['--version'], timeoutMs: 15_000 });
  const data = r.ok
    ? { ready: true, state: 'ready', version: String(r.stdout || '').trim().slice(0, 60) }
    : { ready: false, state: /не установлен/.test(r.error) ? 'absent' : 'error', error: r.error };
  claudeStatusCache = { at: now, data };
  return data;
}

app.get('/api/claude-status', async (req, res) => {
  const base = await claudeStatus(req.query.fresh === '1');
  // deep=1 — настоящий крошечный запрос. `--version` отвечает и без входа,
  // поэтому по нему нельзя отличить «установлен» от «авторизован».
  if (req.query.deep === '1' && base.ready) {
    const probe = await runClaude('Reply with exactly: OK',
      { args: ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL], timeoutMs: 45_000 });
    if (!probe.ok) {
      return res.json({ success: true, ...base, ready: false, state: 'unauthorized', error: probe.error });
    }
    let text = '';
    try { text = String(JSON.parse(probe.stdout).result || '').trim(); } catch { text = String(probe.stdout || '').slice(0, 120); }
    return res.json({ success: true, ...base, state: 'authorized', probe: text });
  }
  res.json({ success: true, ...base });
});

// Совет по открытой позиции. Числа берём готовыми из окна: пересчитывать их
// здесь заново значило бы завести второй источник правды.
app.post('/api/advise-sell', async (req, res) => {
  const b = req.body || {};
  const coin = String(b.coin || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 15);
  if (!coin) return res.status(400).json({ success: false, error: 'нет монеты' });

  // Покупка и продажа — разные вопросы к одной монете, поэтому и кеш разный.
  const side = b.side === 'buy' ? 'buy' : 'sell';
  const cacheKey = side + ':' + coin;
  const cached = claudeAdviceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CLAUDE_CACHE_MS) {
    return res.json({ success: true, ...cached.data, cached: true });
  }
  // Раньше здесь был мгновенный отказ, и открытое второе окно получало
  // «уже думает над другой монетой» вместо ответа. Ждём освобождения —
  // вызов идёт секунды, а не минуты.
  // Ждём дольше самого вызова, иначе второй клиент получал «занят» ровно
  // тогда, когда первый разбор ещё считался.
  for (let waited = 0; claudeInFlight > 0 && waited < 50_000; waited += 400) {
    await new Promise(r => setTimeout(r, 400));
  }
  if (claudeInFlight > 0) return res.json({ success: false, error: 'советник занят, попробуй ещё раз' });

  const num = (v, d = 2) => Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : null;
  const gate = (scalpScan.results || []).find(r => r.coin === coin);
  const micro = (microScalpScan.results || []).find(r => r.coin === coin);
  const common = {
    coin,
    execution: { bookLevels: num(b.levels, 0), slippagePct: num(b.slip, 3), spreadPct: num(b.spreadPct, 3) },
    marketRegime: scalpScan.regime
      ? { btcVsEma20Pct: scalpScan.regime.distPct, btc7dReturnPct: scalpScan.regime.ret7 }
      : 'not computed yet',
  };
  const facts = side === 'buy'
    ? {
      ...common,
      order: { spendUsd: num(b.usd), avgFillPrice: num(b.avgPrice, 8), receiveQty: num(b.qty, 6) },
      // Переплата против лимитки — единственное здесь число, которое точно
      // известно и точно стоит денег.
      vsLimitOrder: { overpayPct: num(b.vsLimitPct, 3), overpayUsd: num(b.vsLimitUsd) },
      lastMinute: { direction: b.trend || null, changePct: num(b.trendPct, 3), cheapest: num(b.cheapest, 8), dearest: num(b.dearest, 8) },
      structuralGate: gate
        ? {
          score: gate.score, conditionsMet: gate.passed + '/' + (gate.checks || []).length,
          verdict: gate.tagOwn || gate.tag, entryAllowed: !!gate.tradeReady,
          unmetConditions: (gate.checks || []).filter(c => !c.ok).map(c => c.en || c.k),
        }
        : 'coin is not in the current 2-6h scan',
      fastGate: micro
        ? { score: micro.score, conditionsMet: micro.passed + '/' + (micro.checks || []).length, readinessPct: micro.readiness && micro.readiness.pct }
        : 'coin is not in the current 15-60min scan',
    }
    : {
      ...common,
      position: { qty: num(b.qty, 6), costUsd: num(b.cost), proceedsUsd: num(b.net), profitUsd: num(b.profit), profitPct: num(b.pct) },
      lastMinute: { direction: b.trend || null, changeUsd: num(b.trendUsd), peakUsd: num(b.peakUsd), troughUsd: num(b.troughUsd) },
      structuralGate: gate
        ? { score: gate.score, conditionsMet: gate.passed + '/' + (gate.checks || []).length, verdict: gate.tagOwn || gate.tag, entryAllowed: !!gate.tradeReady }
        : 'coin is not in the current scan',
    };

  const prompt = (side === 'buy'
    ? [
      'The owner is about to BUY this coin at market, right now, with real money.',
      'Answer in Russian. Reply with EXACTLY this shape and nothing else:',
      'ВЕРДИКТ: <ЖДАТЬ|ПОКУПАТЬ|НЕТ ОСНОВАНИЙ>',
      'ПОЧЕМУ: <one sentence, max 25 words, citing a number from the facts>',
      'РИСК: <one sentence, max 20 words, what would make this wrong>',
      'НАПРАВЛЕНИЕ: <ВВЕРХ|ВНИЗ|В СТОРОНУ> · <низкая|средняя|высокая> уверенность · <one short clause, max 12 words>',
      '',
      'Rules:',
      '- These facts are a snapshot of seconds. They carry no predictive power on their own.',
      '- If the numbers do not support either action, answer НЕТ ОСНОВАНИЙ. That is a valid, expected answer.',
      '- Never invent a probability, a win rate, or a price target. Cite only what is given.',
      '- НАПРАВЛЕНИЕ is your own lean and is REQUIRED even when the verdict is НЕТ ОСНОВАНИЙ.',
      '  Base it on THIS COIN lastMinute movement first. marketRegime (BTC) may only raise or',
      '  lower your confidence -- it must never flip or flatten the direction the coin itself shows.',
      '  If lastMinute has any non-zero move, В СТОРОНУ is the wrong answer: follow that move.',
      '  Use В СТОРОНУ only when the coin itself did not move at all in the window.',
      '  State confidence honestly: on a snapshot of seconds it is almost always низкая.',
      '  A lean with низкая confidence is what is being asked for; refusing to lean is not.',
      '- Both gates are UNVALIDATED experiments. A passing gate is not evidence the trade works;',
      '  an unmet condition is a concrete reason the setup this system looks for is absent.',
      '- overpayPct against a limit order is a certain cost, unlike any expected gain. Weigh it as such.',
    ]
    : [
      'You advise on ONE open crypto position that the owner is about to sell at market.',
      'Answer in Russian. Reply with EXACTLY this shape and nothing else:',
      'ВЕРДИКТ: <ЖДАТЬ|ПРОДАВАТЬ|НЕТ ОСНОВАНИЙ>',
      'ПОЧЕМУ: <one sentence, max 25 words, citing a number from the facts>',
      'РИСК: <one sentence, max 20 words, what would make this wrong>',
      'НАПРАВЛЕНИЕ: <ВВЕРХ|ВНИЗ|В СТОРОНУ> · <низкая|средняя|высокая> уверенность · <one short clause, max 12 words>',
      '',
      'Rules:',
      '- These facts are a snapshot of seconds. They carry no predictive power on their own.',
      '- If the numbers do not support either action, answer НЕТ ОСНОВАНИЙ. That is a valid, expected answer.',
      '- Never invent a probability, a win rate, or a price target. Cite only what is given.',
      '- НАПРАВЛЕНИЕ is your own lean and is REQUIRED even when the verdict is НЕТ ОСНОВАНИЙ.',
      '  Base it on THIS COIN lastMinute movement first. marketRegime (BTC) may only raise or',
      '  lower your confidence -- it must never flip or flatten the direction the coin itself shows.',
      '  If lastMinute has any non-zero move, В СТОРОНУ is the wrong answer: follow that move.',
      '  Use В СТОРОНУ only when the coin itself did not move at all in the window.',
      '  State confidence honestly: on a snapshot of seconds it is almost always низкая.',
      '  A lean with низкая confidence is what is being asked for; refusing to lean is not.',
      '- The structural gate is about ENTRIES over 2-6 hours; it says nothing about exiting an existing position.',
    ])
    .concat(['', 'Facts:', JSON.stringify(facts, null, 1)])
    .join(String.fromCharCode(10));

  claudeInFlight++;
  try {
    const r = await runClaude(prompt, { args: ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL] });
    if (!r.ok) return res.json({ success: false, error: r.error });
    let text = '';
    try {
      const parsed = JSON.parse(r.stdout);
      text = String(parsed.result || '').trim();
    } catch { text = String(r.stdout || '').trim().slice(0, 800); }
    if (!text) return res.json({ success: false, error: 'пустой ответ' });
    const verdict = (text.match(/ВЕРДИКТ:\s*([^\n]+)/) || [])[1] || null;
    // Направление вынимаем отдельно: интерфейс красит его само, а вердикт и
    // направление могут расходиться — «нет оснований действовать» вполне
    // уживается с «склоняюсь, что пойдёт вниз».
    const dirLine = (text.match(/НАПРАВЛЕНИЕ:\s*([^\n]+)/) || [])[1] || null;
    const dir = dirLine
      ? (/ВВЕРХ/i.test(dirLine) ? 'up' : /ВНИЗ/i.test(dirLine) ? 'down' : 'flat')
      : null;
    const conf = dirLine
      ? (/высок/i.test(dirLine) ? 'высокая' : /средн/i.test(dirLine) ? 'средняя' : 'низкая')
      : null;
    const data = {
      advice: text.slice(0, 800),
      verdict: verdict ? verdict.trim() : null,
      direction: dir, confidence: conf,
      directionText: dirLine ? dirLine.trim() : null,
      at: Date.now(),
    };
    claudeAdviceCache.set(cacheKey, { at: Date.now(), data });
    res.json({ success: true, ...data });
  } catch (e) {
    res.json({ success: false, error: e.message });
  } finally {
    claudeInFlight--;
  }
});

// ══════════════════════════════════════════════════════════════════
// ═══ СТОРОЖ ПРОВАЛА: ждём просадку и зовём в Telegram ═══
// ══════════════════════════════════════════════════════════════════
//
// Глубину провала называет Claude, но не из воздуха: ему отдаются измеренные
// размахи последних часов и средний ход пятиминутной свечи, и он обязан
// остаться внутри них. Это по-прежнему оценка, а не прогноз, и сообщение в
// Telegram об этом говорит.
//
// Сторож одноразовый по монете: сработал — снялся. Иначе одна затяжная
// просадка засыпала бы телефон одинаковыми сообщениями.
// Собственные константы: CB объявлен локально внутри других функций,
// общего в модуле нет.
const DIP_CB = 'https://api.exchange.coinbase.com';
const DIP_H = { headers: { 'User-Agent': 'trading-app/1.0' } };
const DIP_WATCH_FILE = path.join(__dirname, 'dip-watch.json');
// Пересчёт идёт по событиям, а не по расписанию: рынок меняется рывками, и
// в тихий час десять минут это слишком часто, а на резком движении --
// непозволительно редко. Границы задают только пол и потолок.
const DIP_REVIEW_MIN_MS = 90 * 1000;        // чаще Opus не зовём
const DIP_REVIEW_MAX_MS = 20 * 60 * 1000;   // и не реже, даже если всё стоит
const dipBusy = new Set();   // монеты, по которым сейчас идёт пересчёт
let dipWatches = {};   // coin -> { at, startPx, targetPx, dipPct, why, pair }
try { dipWatches = JSON.parse(fs.readFileSync(DIP_WATCH_FILE, 'utf8')) || {}; } catch { }
// Сторожа, поставленные до появления верхней границы, её не имеют. Отсутствие
// отметки о пересчёте само означает «пересчитать немедленно», поэтому её
// достаточно снять — на первом же круге границы появятся.
for (const w of Object.values(dipWatches)) {
  if (w && !w.fired && !w.stopped && !(w.abortPx > 0)) { w.reviewedAt = 0; w.retryAfter = 0; }
}
function saveDipWatches() {
  try { fs.writeFileSync(DIP_WATCH_FILE, JSON.stringify(dipWatches, null, 2)); } catch { }
}

async function dipFacts(coin) {
  const pair = coin + '-USD';
  const r = await fetch(`${DIP_CB}/products/${pair}/candles?granularity=300`, DIP_H);
  if (!r.ok) throw new Error('свечи недоступны');
  const raw = await r.json();
  if (!Array.isArray(raw) || raw.length < 20) throw new Error('мало свечей');
  // [time, low, high, open, close, volume], новые вперёд
  const rows = raw.slice(0, 288);
  const px = Number(rows[0][4]);
  const win = (n) => {
    const part = rows.slice(0, n);
    return { low: Math.min(...part.map(x => Number(x[1]))), high: Math.max(...part.map(x => Number(x[2]))) };
  };
  const h1 = win(12), h4 = win(48), h24 = win(288);
  const bodies = rows.slice(0, 12).map(x => (Number(x[2]) - Number(x[1])) / Number(x[4]) * 100).filter(Number.isFinite);
  const avg5m = bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length : null;
  const pct = (from) => from > 0 ? (px / from - 1) * 100 : null;
  const r2 = (v) => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

  // Уровни, от которых цена уже отскакивала. Просто «минус два процента» —
  // это круглое число, а не место, где кто-то готов покупать; выгодный вход
  // стоит искать там, где рынок уже разворачивался. Минимумы 5m свечей за
  // сутки сбиваем в корзины по 0.25% и берём те, куда цена возвращалась
  // хотя бы дважды.
  const lows = rows.map(x => Number(x[1])).filter(v => v > 0 && v < px);
  const buckets = new Map();
  for (const lo of lows) {
    const key = Math.round((px / lo - 1) * 400) / 400;   // шаг 0.25% ниже цены
    const b = buckets.get(key) || { belowPct: key * 100, touches: 0, sum: 0 };
    b.touches++; b.sum += lo;
    buckets.set(key, b);
  }
  // Расстояние считаем от СРЕДНЕЙ цены корзины, а не от её границы: иначе
  // уровни выходили ровной лесенкой 0.25 / 0.5 / 0.75, то есть теми самыми
  // круглыми числами, вместо которых всё это и затевалось.
  //
  // И отбираем по числу касаний, а не по близости: сильный уровень чуть
  // глубже важнее слабого прямо под ценой. Уже отобранные потом ставим по
  // возрастанию глубины, чтобы читались сверху вниз.
  const bounceLevels = [...buckets.values()]
    .filter(b => b.touches >= 2 && b.belowPct > 0.05)
    .map(b => ({ price: b.sum / b.touches, touches: b.touches }))
    .map(b => ({ belowPct: r2((px / b.price - 1) * 100), price: b.price, touches: b.touches }))
    .filter(b => b.belowPct > 0.05)
    .sort((a, b) => b.touches - a.touches || a.belowPct - b.belowPct)
    .slice(0, 4)
    .sort((a, b) => a.belowPct - b.belowPct);

  // Плотная заявка в стакане — второй вид уровня: там продавцу придётся
  // пробивать чужие деньги, а не воздух.
  let bidWall = null;
  try {
    const rb = await fetch(`${DIP_CB}/products/${pair}/book?level=2`, DIP_H);
    if (rb.ok) {
      const book = await rb.json();
      let best = null;
      for (const [pxs, szs] of (book.bids || []).slice(0, 120)) {
        const bp = Number(pxs), bs = Number(szs);
        if (!(bp > 0) || !(bs > 0)) continue;
        const below = (px / bp - 1) * 100;
        if (below < 0.05 || below > 6) continue;
        const usd = bp * bs;
        if (!best || usd > best.usd) best = { usd, belowPct: below, price: bp };
      }
      if (best) bidWall = { belowPct: r2(best.belowPct), price: best.price, usd: Math.round(best.usd) };
    }
  } catch { /* стакан не обязателен: без него остаются уровни по свечам */ }

  // RSI(14) на 5m и место цены в суточном диапазоне: по ним видно, дно это
  // или середина падения, которое ещё идёт.
  const closes = rows.slice(0, 15).map(x => Number(x[4])).reverse();
  let rsi = null;
  if (closes.length === 15) {
    let up = 0, dn = 0;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) up += d; else dn -= d;
    }
    rsi = dn === 0 ? 100 : Math.round(100 - 100 / (1 + (up / 14) / (dn / 14)));
  }
  const span24 = h24.high - h24.low;

  return {
    coin, price: px,
    last1h: { lowPct: pct(h1.low), highPct: pct(h1.high) },
    last4h: { lowPct: pct(h4.low), highPct: pct(h4.high) },
    last24h: { lowPct: pct(h24.low), highPct: pct(h24.high) },
    avg5mCandleRangePct: avg5m == null ? null : Math.round(avg5m * 1000) / 1000,
    chg15mPct: rows[3] ? r2((px / Number(rows[3][4]) - 1) * 100) : null,
    chg1hPct: rows[12] ? r2((px / Number(rows[12][4]) - 1) * 100) : null,
    posIn24hRangePct: span24 > 0 ? r2((px - h24.low) / span24 * 100) : null,
    rsi14_5m: rsi,
    bounceLevels,
    bidWall,
  };
}

// Спрашиваем СРАЗУ обе границы: где ждать покупку и где ждать уже нет
// смысла. Одной глубины мало — монета может уйти вверх, и сторож, который
// умеет только ждать падения, будет молча висеть на исчезнувшей возможности.
// Обе границы называются по одним и тем же измеренным размахам, поэтому и
// пересчитываются вместе.
async function askDipDepth(coin) {
  const facts = await dipFacts(coin);
  const prompt = [
    'A trader wants to buy this coin on a dip. Name two levels: how far it could realistically',
    'dip from here, and how far up would mean the setup is gone.',
    'Answer in Russian. Reply with EXACTLY these three lines and nothing else:',
    'ЦЕЛЬ: <number>%',
    'ОТМЕНА: <number>%',
    'ПОЧЕМУ: <one sentence, max 20 words, citing a number from the facts>',
    '',
    'Rules:',
    '- ЦЕЛЬ is a POSITIVE number: how many percent BELOW the current price to wait for.',
    '- Aim at a LEVEL, not at a round percentage. bounceLevels are places the price already',
    '  turned around (touches = how many times), bidWall is where real money is queued to buy.',
    '  If one of them sits inside the sensible range, put ЦЕЛЬ on it -- an entry there is worth',
    '  more than the same depth in empty space. Prefer more touches and a nearer level.',
    '- It must stay inside what the facts already show. Do not exceed the 24h low distance,',
    '  and do not go below the average 5m candle range -- smaller than that is noise, not a dip.',
    '- A small ЦЕЛЬ is a perfectly good answer when the measured ranges are small. Do not',
    '  inflate it to look decisive.',
    '- Read the state, not just the ranges: rsi14_5m near 30 with posIn24hRangePct low means the',
    '  fall is already spent and a shallow ЦЕЛЬ is enough; a fresh drop (chg15mPct strongly',
    '  negative) with rsi still high means it has further to go, so do not buy the first step down.',
    '- ПОЧЕМУ must name the level you aimed at when you used one.',
    '- ОТМЕНА is a POSITIVE number: how many percent ABOVE the current price would mean waiting',
    '  for a dip no longer makes sense -- the move left without us and buying here is chasing.',
    '  Base it on the same measured ranges. Sensible range 0.5% to 6%.',
    '- Never invent volatility, a probability, or a level the numbers do not support.',
    '- Sensible ЦЕЛЬ here is roughly 0.3% to 5%. Pick one number, not a range.',
    '',
    'Facts:',
    JSON.stringify(facts, null, 1),
  ].join(String.fromCharCode(10));

  const r = await runClaude(prompt, { args: ['-p', '--output-format', 'json', '--model', CLAUDE_MODEL], timeoutMs: 45_000 });
  if (!r.ok) throw new Error(r.error);
  let text = '';
  try { text = String(JSON.parse(r.stdout).result || '').trim(); } catch { text = String(r.stdout || '').trim(); }
  const m = text.match(/ЦЕЛЬ:\s*-?([\d.,]+)\s*%/);
  const why = (text.match(/ПОЧЕМУ:\s*([^\n]+)/) || [])[1] || '';
  let dip = m ? parseFloat(String(m[1]).replace(',', '.')) : NaN;
  if (!Number.isFinite(dip)) throw new Error('не удалось прочитать глубину из ответа');
  // Держим в разумных рамках независимо от ответа: сторож не должен ждать
  // ни шума, ни обвала, которого не было в измерениях.
  dip = Math.max(0.3, Math.min(8, Math.abs(dip)));
  // Уровень отмены читаем отдельно. Если модель его не назвала, ставим свой:
  // без верхней границы сторож остался бы висеть на уехавшей монете, а это
  // ровно то, ради чего граница и нужна.
  const mu = text.match(/ОТМЕНА:\s*\+?([\d.,]+)\s*%/);
  let up = mu ? parseFloat(String(mu[1]).replace(',', '.')) : NaN;
  if (!Number.isFinite(up)) up = dip * 1.5;
  up = Math.max(0.5, Math.min(10, Math.abs(up)));
  return { dip, up, why: why.trim(), price: facts.price };
}

// Повод пересчитать границы, или null. Вынесено из цикла отдельно: это
// единственное место, где решается, когда звать Opus, и его надо уметь
// проверить без биржи и без модели.
//
// Поводов два: цена заметно ушла от той, по которой считали в прошлый раз,
// либо давно не смотрели. Пол в полторы минуты не даёт дёргать модель на
// каждом тике, потолок в двадцать минут не даёт границам застояться на
// спокойном рынке.
//
// Отдельного повода «подошли к цели» здесь нет намеренно: цель всегда стоит
// на dipPct ниже опорной цены, а порог сдвига — 0.4 от той же величины, так
// что подойти к цели, не пробив порог сдвига, невозможно. Такая проверка
// была бы мёртвой веткой.
function dipReviewReason(w, bid, now) {
  if (!w || !(bid > 0)) return null;
  if (now < (w.retryAfter || 0)) return null;
  const sinceReview = now - (w.reviewedAt || 0);
  if (sinceReview < DIP_REVIEW_MIN_MS) return null;
  if (sinceReview >= DIP_REVIEW_MAX_MS) return 'давно';
  const base = w.reviewPx > 0 ? w.reviewPx : w.startPx;
  if (!(base > 0)) return 'нет опорной цены';
  const drift = Math.abs(bid / base - 1) * 100;
  // Порог сдвига привязан к самой цели: у мелкой цели в полпроцента и уход
  // на четверть процента уже меняет расклад, у крупной — нет.
  if (drift >= Math.max(0.25, (w.dipPct || 1) * 0.4)) return 'цена ушла на ' + drift.toFixed(2) + '%';
  return null;
}

app.get('/api/dip-watch', (req, res) => {
  res.json({ success: true, watches: dipWatches });
});

app.post('/api/dip-watch', async (req, res) => {
  const coin = String((req.body || {}).coin || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 15);
  const enable = (req.body || {}).enable !== false;
  if (!coin) return res.status(400).json({ success: false, error: 'нет монеты' });
  if (!enable) {
    delete dipWatches[coin];
    saveDipWatches();
    return res.json({ success: true, watches: dipWatches });
  }
  try {
    const { dip, up, why, price } = await askDipDepth(coin);
    dipWatches[coin] = {
      at: Date.now(), pair: coin + '-USD',
      startPx: price, targetPx: price * (1 - dip / 100),
      dipPct: Math.round(dip * 100) / 100, why,
      // Верхняя граница отсчитывается от цены постановки и дальше не растёт
      // вместе с ценой: иначе она убегала бы вверх ровно от того движения,
      // которое и должна ловить.
      abortPx: price * (1 + up / 100),
      upPct: Math.round(up * 100) / 100,
      // Постановка -- это и есть первый пересчёт: границы только что названы
      // по свежим фактам, второй раз спрашивать не за чем.
      reviewedAt: Date.now(), reviewPx: price,
    };
    saveDipWatches();
    res.json({ success: true, watch: dipWatches[coin], watches: dipWatches });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Проверяем цены раз в 30 секунд. Отдельный цикл, а не внутри скана: сторож
// должен работать и по монете, которой в скане нет.
setInterval(async () => {
  const coins = Object.keys(dipWatches);
  if (!coins.length) return;
  for (const coin of coins) {
    const w = dipWatches[coin];
    if (!w || !(w.targetPx > 0)) { delete dipWatches[coin]; saveDipWatches(); continue; }
    if (w.fired || w.stopped) continue;   // отработал и ждёт сброса
    if (dipBusy.has(coin)) continue;       // идёт пересчёт, цену трогаем следующим кругом
    try {
      const r = await fetch(`${DIP_CB}/products/${w.pair}/ticker`, DIP_H);
      if (!r.ok) continue;
      const t = await r.json();
      const bid = Number(t.bid);
      if (!(bid > 0)) continue;

      // Ушла вверх настолько, что ждать провал уже не имеет смысла: покупка
      // здесь — это погоня за уехавшим движением. Сторож снимается сам и
      // говорит об этом, иначе он молча висел бы на исчезнувшей возможности.
      if (w.abortPx > 0 && bid >= w.abortPx) {
        const rose = (bid / w.startPx - 1) * 100;
        const sent = await sendTelegram(
          '🚫 <b>' + escTg(coin) + '</b> — сторож снят, монета ушла вверх' + NL +
          '━━━━━━━━━━━━━━━━━━' + NL +
          'Цена: <b>$' + fmtPxAe(bid) + '</b> (ставили от $' + fmtPxAe(w.startPx) + ')' + NL +
          'Выросла на <b>+' + rose.toFixed(2) + '%</b>, отмена стояла на +' + w.upPct + '%' + NL + NL +
          '<i>Ждать падения с этого уровня — уже погоня: движение ушло без нас,' + NL +
          'и покупка здесь опаснее, чем пропустить её целиком.</i>' + NL +
          '(сторож снят, падение больше не отслеживается)', 'HTML');
        if (!sent) { console.error('[dip-watch] ' + coin + ': Telegram не принял отмену, сторож оставлен'); continue; }
        w.stopped = 'up';
        w.stoppedAt = Date.now();
        w.stoppedPx = bid;
        w.rosePct = Math.round(rose * 100) / 100;
        saveDipWatches();
        console.log('[dip-watch] ' + coin + ' снят ростом на ' + bid + ' (+' + rose.toFixed(2) + '%)');
        continue;
      }

      // Пересчитываем не по часам, а когда обстановка действительно сменилась.
      // Поводов три: цена заметно ушла от той, по которой считали в прошлый
      // раз; цена подошла к цели вплотную и решение вот-вот понадобится;
      // либо просто давно не смотрели. Пол в полторы минуты не даёт дёргать
      // Opus на каждом тике, потолок в двадцать минут не даёт границам
      // застояться на спокойном рынке.
      const reason = dipReviewReason(w, bid, Date.now());
      if (reason) {
        dipBusy.add(coin);
        try {
          const nx = await askDipDepth(coin);
          const cur = dipWatches[coin];
          if (cur && !cur.fired && !cur.stopped) {
            const wasDip = cur.dipPct;
            cur.targetPx = nx.price * (1 - nx.dip / 100);
            cur.dipPct = Math.round(nx.dip * 100) / 100;
            cur.upPct = Math.round(nx.up * 100) / 100;
            // Отмена по-прежнему считается от цены ПОСТАНОВКИ, а не от текущей:
            // привязка к текущей делала бы порог недостижимым при плавном росте.
            cur.abortPx = cur.startPx * (1 + nx.up / 100);
            if (nx.why) cur.why = nx.why;
            cur.reviewedAt = Date.now();
            cur.reviewPx = nx.price;
            cur.reviewReason = reason;
            saveDipWatches();
            console.log('[dip-watch] ' + coin + ' пересчитан (' + reason + '): ' + wasDip + '% -> ' +
              cur.dipPct + '%, отмена +' + cur.upPct + '%');
          }
        } catch (e) {
          // Пересчитать не вышло — оставляем прежние границы и пробуем позже.
          // Снимать сторож из-за недоступного Claude было бы худшим исходом.
          w.retryAfter = Date.now() + 60_000;
          console.error('[dip-watch] ' + coin + ': пересчёт не удался — ' + e.message);
        } finally {
          dipBusy.delete(coin);
        }
        continue;
      }

      if (bid > w.targetPx) continue;
      const fell = (bid / w.startPx - 1) * 100;
      const sent = await sendTelegram(
        '📉 <b>' + escTg(coin) + '</b> — просадка, которую ты ждал' + NL +
        '━━━━━━━━━━━━━━━━━━' + NL +
        'Цена: <b>$' + fmtPxAe(bid) + '</b> (было $' + fmtPxAe(w.startPx) + ')' + NL +
        'Упало на <b>' + fell.toFixed(2) + '%</b>, ждали ' + w.dipPct + '%' + NL +
        (w.why ? NL + '<i>' + escTg(w.why) + '</i>' + NL : '') + NL +
        '<i>Глубина названа по измеренным размахам последних часов, но это' + NL +
        'оценка, а не прогноз. Падение может продолжиться.</i>' + NL +
        '(сторож одноразовый — снят)', 'HTML');
      // Снимаем ТОЛЬКО если сообщение ушло: иначе отказ Telegram выглядел бы
      // так, будто просадки не было.
      if (!sent) { console.error('[dip-watch] ' + coin + ': Telegram не принял, сторож оставлен'); continue; }
      // Не удаляем, а помечаем сработавшим: интерфейсу нужно что-то показать,
      // иначе кнопка молча вернулась бы в исходное и выглядела бы так, будто
      // ничего не было. Убирает запись только явный сброс.
      w.fired = true;
      w.firedAt = Date.now();
      w.firedPx = bid;
      w.fellPct = Math.round(fell * 100) / 100;
      saveDipWatches();
      console.log('[dip-watch] ' + coin + ' сработал на ' + bid + ' (-' + fell.toFixed(2) + '%)');
    } catch (e) { console.error('[dip-watch]', coin, e.message); }
  }
}, 30_000);

// ── Ручное открытие paper-сделки из таблицы (ведётся тем же движком) ──
app.post('/api/paper/open', async (req, res) => {
  try {
    const { coin, pair } = req.body || {};
    if (!coin) return res.status(400).json({ success: false, error: 'no coin' });
    if (paperBot.open.some(p => p.coin === coin)) {
      return res.json({ success: false, error: `${coin} уже в paper-портфеле` });
    }
    const productId = pair || `${coin}-USD`;
    // Эмулируем то же, что делаешь руками: лимитка по лучшему ask, комиссия limit-ордера
    const ask = await fetchBestAsk(productId);
    if (!(ask > 0)) return res.json({ success: false, error: 'Не удалось получить ask' });

    const src = topLosersCache.data.find(x => x.coin === coin);
    const pos = buildPaperPos(coin, productId, ask, src ? {
      rb: src.rb, rbTag: src.rbTag, rv: src.rv ? src.rv.score : null,
      rvTag: src.rv ? src.rv.tag : null, pct30d: Math.round(src.pct30d * 10) / 10
    } : {}, 'manual');
    paperBot.open.push(pos);
    savePaperBot();
    console.log(`[paper] РУЧНОЕ открытие ${coin} ask=$${ask} target +${pos.targetPct}%`);
    // Telegram молчит — сообщения только через кнопку BUY
    res.json({ success: true, position: pos });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Удалить paper-сделку БЕЗ записи в историю (ошибочно открыл)
app.delete('/api/paper/open/:id', (req, res) => {
  const before = paperBot.open.length;
  paperBot.open = paperBot.open.filter(p => p.id !== req.params.id);
  if (paperBot.open.length === before) return res.json({ success: false, error: 'not found' });
  savePaperBot();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════
// ═══ РАЗМЕЩЕНИЕ ЛИМИТКИ: где ставить заявку ═══
// Всё преимущество стратегии ≈ +0.2% на сделку, а круг комиссий 0.25%
// и спред на неликвиде ещё столько же. Считаем компромисс между ценой
// и вероятностью исполнения по реальному стакану и ленте сделок.
// ══════════════════════════════════════════════════════════════════
app.get('/api/limit-advice/:coin', async (req, res) => {
  try {
    const coin = req.params.coin.toUpperCase();
    const pair = `${coin}-USD`;
    const usd = parseFloat(req.query.usd) || 100;
    const H2 = { headers: { 'User-Agent': 'trading-app/1.0' } };

    const [bookRes, tradesRes, statsRes] = await Promise.all([
      fetch(`https://api.exchange.coinbase.com/products/${pair}/book?level=2`, H2),
      fetch(`https://api.exchange.coinbase.com/products/${pair}/trades?limit=100`, H2),
      fetch(`https://api.exchange.coinbase.com/products/${pair}/stats`, H2),
    ]);
    if (!bookRes.ok) return res.json({ success: false, error: 'нет стакана' });
    const book = await bookRes.json();
    const bids = (book.bids || []).map(b => [parseFloat(b[0]), parseFloat(b[1])]);
    const asks = (book.asks || []).map(a => [parseFloat(a[0]), parseFloat(a[1])]);
    if (!bids.length || !asks.length) return res.json({ success: false, error: 'пустой стакан' });

    const bestBid = bids[0][0], bestAsk = asks[0][0];
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = (bestAsk - bestBid) / mid * 100;

    // Насколько активно торгуется: сделок в минуту и медианный размер
    let tradesPerMin = null, downTradesPerMin = null;
    try {
      const tr = await tradesRes.json();
      if (Array.isArray(tr) && tr.length > 1) {
        const now = Date.now();
        const times = tr.map(t => new Date(t.time).getTime()).filter(x => x > 0);
        const spanMin = times.length ? (now - Math.min(...times)) / 60000 : null;
        if (spanMin > 0) {
          tradesPerMin = Math.round(times.length / spanMin * 10) / 10;
          // side='buy' у Coinbase = агрессивный продавец, цена идёт вниз к нашей лимитке
          const down = tr.filter(t => t.side === 'buy').length;
          downTradesPerMin = Math.round(down / spanMin * 10) / 10;
        }
      }
    } catch { }

    const s = statsRes.ok ? await statsRes.json() : null;
    const vol24 = s ? (parseFloat(s.volume) || 0) * (parseFloat(s.last) || 0) : 0;

    const settings = loadSettings();
    const limitFee = (parseFloat(settings.tradeFee) || defaultSettings.tradeFee) / 100;
    const marketFee = (parseFloat(settings.marketFee) || defaultSettings.marketFee) / 100;
    const target = parseFloat(settings.sellMarkup) || 1.38;

    // Варианты размещения: по ask (мгновенно), по bid, и глубже по стакану
    const levels = [];
    const pushLevel = (price, label, note, instant) => {
      // сколько объёма надо съесть встречной стороне, чтобы дойти до нас
      let ahead = 0;
      for (const [p, sz] of bids) { if (p > price) ahead += p * sz; else break; }
      const costVsMid = (price / mid - 1) * 100;
      // чистая прибыль, если продать по цели с той же лимитной комиссией
      const net = target - (limitFee * 2 * 100) - costVsMid;
      levels.push({
        label, price: Math.round(price * 1e10) / 1e10, note,
        vsMidPct: Math.round(costVsMid * 1000) / 1000,
        queueAheadUsd: Math.round(ahead),
        instant: !!instant,
        netIfTargetPct: Math.round(net * 1000) / 1000,
        // грубая оценка времени в очереди по темпу нисходящих сделок
        etaMin: instant ? 0 : (downTradesPerMin > 0 && vol24 > 0
          ? Math.round(Math.min(600, ahead / Math.max(1, vol24 / 1440)) )
          : null),
      });
    };
    pushLevel(bestAsk, 'По ask (сразу)', 'Исполнится немедленно, но платишь весь спред', true);
    pushLevel(bestBid, 'По bid (1-й уровень)', 'Встаёшь первым в очередь покупателей', false);
    if (bids[1]) pushLevel(bids[1][0], 'Bid −1 уровень', 'Дешевле, но ждать дольше', false);
    if (bids[3]) pushLevel(bids[3][0], 'Bid −3 уровня', 'Заметно дешевле, исполнение не гарантировано', false);

    // Рекомендация: если спред мал относительно цели — брать по ask и не ждать
    const spreadShare = spreadPct / target * 100;   // какую долю цели съедает спред
    let advice, why;
    if (spreadShare < 8) {
      advice = 'По ask';
      why = `Спред ${spreadPct.toFixed(2)}% — это лишь ${Math.round(spreadShare)}% от цели ${target}%. Ждать очередь невыгодно: риск упустить движение больше экономии.`;
    } else if (spreadShare < 25) {
      advice = 'По bid';
      why = `Спред ${spreadPct.toFixed(2)}% съедает ${Math.round(spreadShare)}% цели. Ставь лимитку по bid: сэкономишь ${(spreadPct).toFixed(2)}%, обычно исполняется за минуты.`;
    } else {
      advice = 'По bid, и подумать дважды';
      why = `Спред ${spreadPct.toFixed(2)}% — это ${Math.round(spreadShare)}% от цели ${target}%. Вход и выход съедят почти всё преимущество. Такую монету лучше пропустить.`;
    }

    res.json({
      success: true, coin, pair,
      bestBid, bestAsk, mid: Math.round(mid * 1e10) / 1e10,
      spreadPct: Math.round(spreadPct * 1000) / 1000,
      spreadShareOfTarget: Math.round(spreadShare),
      vol24: Math.round(vol24), tradesPerMin, downTradesPerMin,
      targetPct: target, limitFeePct: limitFee * 100, marketFeePct: marketFee * 100,
      roundTripFeePct: Math.round(limitFee * 2 * 100 * 1000) / 1000,
      usd, levels, advice, why,
    });
  } catch (e) {
    console.error('[limit-advice]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ═══ АВТОПЕРЕПРОВЕРКА КАЛИБРОВКИ ═══
// Обе системы откалиброваны на одном эпизоде рынка. Раз в неделю сверяем
// заявленное ожидание с тем, что реально дали paper-сделки и журнал,
// и присылаем отчёт. Плохая новость приходит раньше убытков.
// ══════════════════════════════════════════════════════════════════
const CALIB_FILE = path.join(__dirname, 'calibration-log.json');
let calibLog = [];
try { calibLog = JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch { }

// Ожидания из бэктестов — с чем сравниваем факт
const CALIB_BASELINE = {
  swing: { winRate: 44, expPct: 0.27, note: 'гейт REV 4/4, горизонт 1–3 дня, 1635 сэмплов' },
  scalp: { winRate: null, expPct: null, note: 'requires a matching historical validation' },
};

function buildCalibrationReport() {
  const closed = paperBot.closed || [];
  const since = Date.now() - 30 * 86400 * 1000;
  const recent = closed.filter(p => p.closedAt >= since);
  const group = (arr) => {
    if (!arr.length) return null;
    const wins = arr.filter(p => p.pnl > 0).length;
    const totalPct = arr.reduce((a, p) => a + (p.pnlPct || 0), 0);
    return {
      n: arr.length, wins, losses: arr.length - wins,
      winRate: Math.round(wins / arr.length * 100),
      expPct: Math.round(totalPct / arr.length * 1000) / 1000,
      totalUsd: Math.round(arr.reduce((a, p) => a + p.pnl, 0) * 100) / 100,
    };
  };
  // Отделяем сделки по reversal-сигналу от прочих
  const bySignal = {
    swing: group(recent.filter(p => p.ctx && p.ctx.rv != null && p.ctx.rv >= 77)),
    all: group(recent),
  };
  const journalClosed = (journal.closed || []).filter(t => t.closedAt >= since);
  return {
    at: Date.now(),
    windowDays: 30,
    paper: bySignal,
    realTrades: journalClosed.length
      ? { n: journalClosed.length, winRate: Math.round(journalClosed.filter(t => t.pnl > 0).length / journalClosed.length * 100), totalUsd: Math.round(journalClosed.reduce((a, t) => a + t.pnl, 0) * 100) / 100 }
      : null,
    baseline: CALIB_BASELINE,
    scalpValidation: scalpValidationStatus(),
    regime: scalpScan.regime ? { btcAbove: scalpScan.regime.above, distPct: scalpScan.regime.distPct } : null,
  };
}

async function runCalibrationCheck(silent) {
  const rep = buildCalibrationReport();
  calibLog.push(rep);
  calibLog = calibLog.slice(-52);
  try { fs.writeFileSync(CALIB_FILE, JSON.stringify(calibLog, null, 2)); } catch { }

  const p = rep.paper.all, sw = rep.paper.swing;
  if (!p || p.n < 10) {
    console.log(`[calibration] сделок мало (${p ? p.n : 0}), отчёт пропущен`);
    if (!silent) return rep;
    return rep;
  }
  const base = CALIB_BASELINE.swing;
  const drift = sw ? sw.winRate - base.winRate : null;
  const verdict = drift == null ? 'нет данных по гейту'
    : drift >= -5 ? '✅ держится'
    : drift >= -12 ? '⚠️ просело'
    : '🔴 не работает';
  const text =
    `📐 <b>ПРОВЕРКА КАЛИБРОВКИ</b> — за 30 дней\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<b>Paper, все сделки:</b> ${p.n} шт · ${p.winRate}% побед · ${p.expPct >= 0 ? '+' : ''}${p.expPct}% на сделку · итого ${p.totalUsd >= 0 ? '+' : ''}$${p.totalUsd}\n` +
    (sw ? `<b>Только по гейту (77+):</b> ${sw.n} шт · ${sw.winRate}% побед · ${sw.expPct >= 0 ? '+' : ''}${sw.expPct}%\n` : '') +
    `\n<b>Ожидалось по бэктесту:</b> ${base.winRate}% побед, +${base.expPct}% на сделку\n` +
    `<b>Вердикт:</b> ${verdict}${drift != null ? ` (${drift >= 0 ? '+' : ''}${drift} п.п. к ожиданию)` : ''}\n` +
    (rep.realTrades ? `\n<b>Реальные сделки:</b> ${rep.realTrades.n} шт · ${rep.realTrades.winRate}% · ${rep.realTrades.totalUsd >= 0 ? '+' : ''}$${rep.realTrades.totalUsd}\n` : '') +
    `\n<i>Калибровка сделана на одном рыночном эпизоде. Если вердикт\nне «держится» два отчёта подряд — пороги пора пересчитывать.</i>`;
  // В Telegram не шлём: это статистика по paper-сделкам, а туда идут только
  // сигналы кнопки Алерт и события по реальным ордерам. Отчёт живёт в логе
  // и в /api/calibration.
  if (!silent) console.log(`[calibration] ${verdict}\n${text.replace(/<[^>]+>/g, '')}`);
  return rep;
}

// Раз в неделю; первый прогон через 3 минуты после старта — молча, только в лог
setInterval(() => runCalibrationCheck(false), 7 * 24 * 3600 * 1000);
setTimeout(() => runCalibrationCheck(true), 180_000);

app.get('/api/calibration', (req, res) => {
  const fresh = buildCalibrationReport();
  res.json({ success: true, current: fresh, history: calibLog.slice(-12).reverse() });
});

app.post('/api/calibration/run', async (req, res) => {
  const rep = await runCalibrationCheck(false);
  res.json({ success: true, report: rep });
});

// Start server — check port first, then listen
const net = require('net');

function checkPort(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => { tester.close(); resolve(true); })
      .listen(port, HOST);
  });
}

async function startServer(retries = 10) {
  for (let i = 0; i < retries; i++) {
    const free = await checkPort(PORT);
    if (free) {
      server = app.listen(PORT, HOST, () => {
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
