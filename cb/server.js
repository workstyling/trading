const express = require('express');
const http = require('http');
const path = require('path');
require('dotenv').config();
const { RESTClient } = require('./dist/rest/index.js');
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const axios = require('axios');
const { coinbaseScraper, getMonthlyLosers, dataManager } = require('./scraper');
const fs = require('fs');

// Инициализация Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://tradingcryptodata-default-rtdb.firebaseio.com',
});

const db = admin.database();

const app = express();
const server = http.createServer(app);

// Добавляем middleware для правильного MIME-типа JavaScript файлов
app.use('/database.js', (req, res, next) => {
  res.setHeader('Content-Type', 'text/javascript');
  next();
});

// Serve index.html directly with no-cache headers (bypasses static middleware cache)
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
app.use(express.json());

app.post('/api/groq/chat', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt ?? '').trim();
    if (!prompt) return res.status(400).json({ success: false, error: 'Empty prompt' });
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
      let coinSummary = '';
      try {
        const m = prompt.toUpperCase().match(/\b[A-Z0-9]{2,10}\b/);
        const coin = m ? m[0] : null;
        if (coin) {
          const r = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`);
          if (r.ok) {
            const d = await r.json();
            if (d?.bid && d?.ask) {
              coinSummary = `Цена ${coin}: bid ${d.bid}, ask ${d.ask}`;
            }
          }
        }
      } catch {}

      let mathSummary = '';
      try {
        const s = prompt.toLowerCase().replace(/[,]/g,' ').replace(/\s+/g,' ').trim();
        const hasPlus = /\bплюс\b|\+/i.test(s);
        const hasMinus = /\bминус\b|-/i.test(s);
        const hasMul = /\b(умножить|умножение|умножить на|умножь|умнож)\b|[\*×]/i.test(s);
        const hasDiv = /\b(разделить|делить|поделить|делить на)\b|[\/÷]/i.test(s);
        if (hasPlus || hasMinus || hasMul || hasDiv) {
          let normalized = s
            .replace(/\bплюс\b/gi,'+')
            .replace(/\bминус\b/gi,'-')
            .replace(/\b(умножить|умножение|умножить на|умножь|умнож)\b/gi,'*')
            .replace(/\b(разделить|делить|поделить|делить на)\b/gi,'/')
            .replace(/[×]/g,'*')
            .replace(/[÷]/g,'/');
          const tokens = normalized.match(/-?\d+(\,\d+|\.\d+)?|[+\-*/]/g);
          if (tokens) {
            let a=null,b=null,operator=null;
            for (let i=0;i<tokens.length;i++) {
              const t = tokens[i];
              if (['+','-','*','/'].includes(t)) { operator = t; continue; }
              const num = parseFloat(t.replace(',','.'));
              if (!isNaN(num)) {
                if (a===null) a=num; else if (operator && b===null) { b=num; break; }
              }
            }
            if (a!==null && b!==null && operator) {
              let result;
              switch(operator){
                case '+': result = a + b; break;
                case '-': result = a - b; break;
                case '*': result = a * b; break;
                case '/': result = b===0 ? '∞' : a / b; break;
              }
              if (typeof result === 'number') {
                const formatted = Number.isFinite(result) ? result.toString() : String(result);
                mathSummary = `Результат: ${formatted}`;
              } else if (result) {
                mathSummary = `Результат: ${result}`;
              }
            }
          }
        }
      } catch {}

      const parts = [];
      if (coinSummary) parts.push(coinSummary);
      if (mathSummary) parts.push(mathSummary);
      const prefix = parts.length ? parts.join('. ') + '. ' : '';
      const text = `DEMO-ответ (без ключа): ${prefix}Ваш ввод: "${prompt}"`;
      return res.json({ success: true, text });
    }

    const groqResp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'Ты помощник для крипто-трейдинга. Отвечай кратко на русском.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 512
    }, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = groqResp.data?.choices?.[0]?.message?.content ?? '';
    res.json({ success: true, text });
  } catch (e) {
    console.error('Groq chat error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Serve Firebase app
app.use('/firebase', express.static(path.join(__dirname, 'firebase-app')));

// Serve React app
app.use('/react', express.static(path.join(__dirname, 'react-app')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  next();
});

const API_KEY =
  'organizations/013f206d-b29c-4c2a-a839-31f6d2ecc959/apiKeys/4e07dfe2-2ea6-4872-806a-21e5053a4e18';
const API_SECRET =
  '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIPmGuws4R6uXGJeKMf2Jubnn+5A/d30zDp7bHjUEy5UuoAoGCCqGSM49\nAwEHoUQDQgAEMHSsv+2jCUDMgMTbGS+/bpA0r00k3xsqfR7plgr1dJAsxhkesNtV\n3lp2ctsXlTaJj6Pdx/MRuksJLdYgwkocPg==\n-----END EC PRIVATE KEY-----\n';
const client = new RESTClient(API_KEY, API_SECRET);

// Хранилище для подключенных клиентов
const clients = new Set();

// Хранилище для выбранных заказов
let selectedOrderIds = [];

// Функции для сохранения/загрузки выбранных ордеров
const selectedOrdersFile = path.join(__dirname, 'selected-orders.json');

function saveSelectedOrdersToFile(orderIds) {
  try {
    fs.writeFileSync(selectedOrdersFile, JSON.stringify(orderIds, null, 2));
    console.log('Selected orders saved to file:', orderIds);
  } catch (error) {
    console.error('Error saving selected orders to file:', error);
  }
}

function loadSelectedOrdersFromFile() {
  try {
    if (fs.existsSync(selectedOrdersFile)) {
      const data = fs.readFileSync(selectedOrdersFile, 'utf8');
      const orderIds = JSON.parse(data);
      console.log('Selected orders loaded from file:', orderIds);
      return Array.isArray(orderIds) ? orderIds : [];
    }
  } catch (error) {
    console.error('Error loading selected orders from file:', error);
  }
  return [];
}

// Загружаем выбранные ордера при запуске сервера
selectedOrderIds = loadSelectedOrdersFromFile();

// WebSocket подключение
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('New client connected');

  ws.on('close', () => {
    clients.delete(ws);
    console.log('Client disconnected');
  });
});

// Настраиваем обработчик обновлений
dataManager.onUpdate = (data) => {
  // Отправляем обновления всем подключенным клиентам
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'l2update',
        data: data
      }));
    }
  });
};

// Функция для отправки обновлений всем подключенным клиентам
function broadcastOrders(orders) {
  console.log('Broadcasting orders to clients:', orders);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'orders_update',
        orders: orders
      }));
    }
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/get-usd-account', async (req, res) => {
  try {
    const result = await client.getAccount({
      accountUuid: 'd5990d03-0efb-5421-968a-ed319df31c61',
    });

    // Парсим результат, если он пришел в виде строки
    const accountData =
      typeof result === 'string' ? JSON.parse(result) : result;
    console.log('Account data:', accountData);

    if (accountData.account && accountData.account.available_balance) {
      res.json({
        success: true,
        balance: accountData.account.available_balance.value,
      });
    } else {
      console.error('Invalid account data:', accountData);
      res.status(500).json({
        success: false,
        error: 'Invalid account data structure',
        data: accountData,
      });
    }
  } catch (error) {
    console.error('Error getting USD account:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

function parseOrderResponse(coinbaseOrder) {
  try {
    if (typeof coinbaseOrder === 'string') {
      coinbaseOrder = JSON.parse(coinbaseOrder);
    }
    return {
      order_id: coinbaseOrder.success_response?.order_id || 'Unknown',
      status: coinbaseOrder.success ? 'Created' : 'Failed',
      client_order_id:
        coinbaseOrder.success_response?.client_order_id || 'Unknown',
      full_response: JSON.stringify(coinbaseOrder),
    };
  } catch (error) {
    console.error('Ошибка при разборе ответа Coinbase:', error);
    return {
      order_id: 'Unknown',
      status: 'Error',
      full_response: JSON.stringify(coinbaseOrder),
    };
  }
}

async function getUSDBalance() {
  try {
    const result = await client.getAccount({
      accountUuid: 'd5990d03-0efb-5421-968a-ed319df31c61',
    });
    console.log('Full account response:', JSON.stringify(result, null, 2));
    if (result && result.account && result.account.available_balance) {
      const balance = result.account.available_balance.value;
      console.log('Updated USD balance:', balance);
      return parseFloat(balance).toFixed(5);
    } else {
      console.error('Unexpected account response structure:', result);
      return null;
    }
  } catch (error) {
    console.error('Error fetching USD balance:', error);
    return null;
  }
}

// Endpoint для получения точных параметров продукта через Advanced Trade API
app.get('/get-product-info/:coin', async (req, res) => {
  try {
    const { coin } = req.params;
    const result = await client.getProduct({ productId: `${coin}-USD` });
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    console.log(`[get-product-info] ${coin}-USD:`, JSON.stringify({ base_increment: data.base_increment, quote_increment: data.quote_increment }));
    res.json({
      success: true,
      base_increment: data.base_increment,
      quote_increment: data.quote_increment,
      base_min_size: data.base_min_size,
    });
  } catch (error) {
    console.error('Error fetching product info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint для создания обычных ордеров
app.post('/create-order', async (req, res) => {
  try {
    const { coin, baseSize, limitPrice, side = 'BUY', postOnly = false } = req.body;

    // Round baseSize and limitPrice server-side to avoid "Too many decimals" errors
    let roundedBaseSize = baseSize;
    let roundedLimitPrice = limitPrice;
    try {
      const productResp = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD`);
      const productData = await productResp.json();
      if (!productData.base_increment) throw new Error('No base_increment in product data');
      const baseIncrement = parseFloat(productData.base_increment);
      const sizeDecimals = productData.base_increment.toString().split('.')[1]?.length || 0;
      const priceDecimals = productData.quote_increment.toString().split('.')[1]?.length || 0;
      const rawSize = Math.floor(parseFloat(baseSize) / baseIncrement) * baseIncrement;
      roundedBaseSize = rawSize.toFixed(sizeDecimals);
      roundedLimitPrice = parseFloat(limitPrice).toFixed(priceDecimals);
      console.log(`[create-order] Rounding: baseSize ${baseSize}→${roundedBaseSize}, limitPrice ${limitPrice}→${roundedLimitPrice} (base_increment=${productData.base_increment}, quote_increment=${productData.quote_increment})`);
    } catch (productErr) {
      console.warn('[create-order] Could not fetch product info for rounding, using raw values:', productErr.message);
    }

    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const orderData = {
      client_order_id: clientOrderId,
      product_id: `${coin}-USD`,
      side: side,
      order_configuration: {
        limit_limit_gtc: {
          base_size: roundedBaseSize,
          limit_price: roundedLimitPrice,
          post_only: postOnly
        }
      }
    };

    console.log('[create-order] Sending to Coinbase:', JSON.stringify({ base_size: roundedBaseSize, limit_price: roundedLimitPrice, product_id: `${coin}-USD` }));

    const response = await client.createOrder(orderData);
    console.log('[create-order] Coinbase response:', response);

    if (!response || response.error) {
      throw new Error(response?.error || 'Failed to create order');
    }

    // Check for success:false in response body (200 with failure)
    let parsedResponse;
    try { parsedResponse = typeof response === 'string' ? JSON.parse(response) : response; } catch {}
    if (parsedResponse && parsedResponse.success === false) {
      const errMsg = parsedResponse.error_response?.message || parsedResponse.error_response?.error_details || 'Order failed';
      throw new Error(errMsg);
    }

    const formattedOrder = formatOrder(response);
    res.json({
      success: true,
      order: formattedOrder
    });
  } catch (error) {
    console.error('Error creating order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint для создания Stop Limit ордеров
app.post('/create-stop-limit-order', async (req, res) => {
  try {
    const { coin, baseSize, stopPrice, limitPrice } = req.body;
    console.log('Creating stop limit order with data:', req.body);

    // Получаем информацию о продукте через публичный API
    const productResponse = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD`);
    const productInfo = await productResponse.json();
    console.log('Product info:', productInfo);

    if (productInfo.error) {
      throw new Error(`Failed to get product info: ${productInfo.message}`);
    }

    // Определяем точность для цены из quote_increment
    const quoteIncrement = productInfo.quote_increment;
    const priceDecimals = quoteIncrement.toString().split('.')[1]?.length || 0;

    // Форматируем цены с правильной точностью
    const formattedStopPrice = Number(stopPrice).toFixed(priceDecimals);
    const formattedLimitPrice = Number(limitPrice).toFixed(priceDecimals);
    const formattedBaseSize = baseSize.toString();

    const clientOrderId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

    const orderData = {
      client_order_id: clientOrderId,
      product_id: `${coin}-USD`,
      side: 'BUY',
      order_configuration: {
        stop_limit_stop_limit_gtc: {
          base_size: formattedBaseSize,
          limit_price: formattedLimitPrice,
          stop_price: formattedStopPrice,
          stop_direction: 'STOP_DIRECTION_STOP_UP'
        }
      }
    };

    console.log('Sending order to Coinbase:', JSON.stringify(orderData, null, 2));

    const response = await client.createOrder(orderData);
    console.log('Coinbase API response:', response);

    if (!response || response.error) {
      throw new Error(response?.error || 'Failed to create order');
    }

    const formattedOrder = formatOrder(response);
    res.json({
      success: true,
      order: formattedOrder
    });

  } catch (error) {
    console.error('Error creating stop limit order:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/get-orders', async (req, res) => {
  try {
    const ordersSnapshot = await db
      .ref('orders')
      .orderByChild('created_at')
      .once('value');
    const orders = [];
    ordersSnapshot.forEach((childSnapshot) => {
      orders.unshift(childSnapshot.val());
    });
    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/delete-order/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    console.log('Попытка удаления ордера с ID:', orderId);

    let deletedFromDatabase = false;
    let deletedFromCoinbase = false;

    // Поиск ордера в базе данных Firebase
    const orderRef = db.ref('orders');
    const snapshot = await orderRef
      .orderByChild('coinbase_order_id')
      .equalTo(orderId)
      .once('value');

    console.log('Результат поиска в базе данных:', snapshot.val());

    if (snapshot.exists()) {
      console.log('Ордер найден в базе данных');

      // Попытка удаления ордера из Coinbase
      try {
        const result = await client.cancelOrders({ order_ids: [orderId] });
        console.log(
          'Ответ Coinbase при отмене ордера:',
          JSON.stringify(result, null, 2)
        );
        deletedFromCoinbase = true;
      } catch (coinbaseError) {
        console.error('Ошибка при отмене ордера на Coinbase:', coinbaseError);
        console.error('Полное сообщение об ошибке:', coinbaseError.message);

        // Проверяем, не является ли ошибка результатом того, что ордер уже отменен или выполнен
        if (
          coinbaseError.message.includes('order not found') ||
          coinbaseError.message.includes('order already done')
        ) {
          console.log('Ордер уже отменен или выполнен на Coinbase');
          deletedFromCoinbase = true;
        }
      }

      // Удаление ордера из базы данных Firebase
      const updates = {};
      snapshot.forEach((childSnapshot) => {
        updates[childSnapshot.key] = null;
      });
      await orderRef.update(updates);
      deletedFromDatabase = true;
      console.log(`Ордер ${orderId} успешно удален из базы данных`);
    } else {
      console.log(`Ордер ${orderId} не найден в базе данных`);

      // Попытка удаления ордера из Coinbase, даже если его нет в базе данных
      try {
        const result = await client.cancelOrders({ order_ids: [orderId] });
        console.log(
          'Ответ Coinbase при отмене ордера (не найденного в БД):',
          JSON.stringify(result, null, 2)
        );
        deletedFromCoinbase = true;
      } catch (coinbaseError) {
        console.error(
          'Ошибка при отмене ордера на Coinbase (не найденного в БД):',
          coinbaseError
        );
        console.error('Полное сообщение об ошибке:', coinbaseError.message);
      }
    }

    // Проверяем результаты удаления
    if (deletedFromDatabase && deletedFromCoinbase) {
      res.json({
        success: true,
        message: 'Ордер успешно удален из базы данных и с Coinbase',
      });
    } else if (deletedFromDatabase) {
      res.json({
        success: true,
        message:
          'Ордер удален из базы данных, но не удалось подтвердить удаление с Coinbase',
      });
    } else if (deletedFromCoinbase) {
      res.json({
        success: true,
        message: 'Ордер удален с Coinbase, но не был найден в базе данных',
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Ордер не найден ни в базе данных, ни на Coinbase',
      });
    }
  } catch (error) {
    console.error('Ошибка при удалении ордера:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Обновим endpoint для проверки статуса ордера
app.get('/check-order-status/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await client.getOrder({ orderId });
    console.log('Raw order status response:', result);

    // Парсим результат
    const orderData = typeof result === 'string' ? JSON.parse(result) : result;

    // Извлекаем нужные данные
    const response = {
      success: true,
      order_id: orderId,
      status: orderData.status,
      filled_size: orderData.filled_size,
      filled_price: orderData.filled_price,
      side: orderData.side,
      product_id: orderData.product_id,
      created_time: orderData.created_time,
      completion_percentage: orderData.completion_percentage,
      total_fees: orderData.total_fees,
      raw_response: orderData, // для отладки
    };

    console.log('Processed order status:', response);
    res.json(response);
  } catch (error) {
    console.error('Error checking order status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      order_id: req.params.orderId,
    });
  }
});

// Добавим endpoint для отмены ордера
app.post('/cancel-order/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;

        // Отправляем запрос на отмену ордера
        const result = await client.cancelOrders({
            orderIds: [orderId]
        });

        console.log('Cancel order response:', result);

        // Проверяем только наличие объекта результата
        if (!result) {
            throw new Error('Нет ответа от Coinbase API');
        }

        // Если нет results или они пустые, считаем что отмена прошла успешно
        // т.к. Coinbase иногда не возвращает results при успешной отмене
        if (!result.results || !result.results.length) {
            res.json({
                success: true,
                message: 'Ордер успешно отменен'
            });
            return;
        }

        const cancelResult = result.results[0];
        
        // Проверяем успешность отмены только если есть явный флаг неуспеха
        if (cancelResult.success === false) {
            // Получаем текст ошибки
            let errorMessage;
            if (typeof cancelResult.failure_reason === 'object') {
                errorMessage = cancelResult.failure_reason?.message || 
                              cancelResult.failure_reason?.error_details || 
                              JSON.stringify(cancelResult.failure_reason);
            } else {
                errorMessage = cancelResult.failure_reason || 'Не удалось отменить ордер';
            }
            
            return res.status(400).json({
                success: false,
                error: errorMessage
            });
        }

        // В остальных случаях считаем отмену успешной
        res.json({
            success: true,
            message: 'Ордер успешно отменен'
        });

    } catch (error) {
        console.error('Ошибка при отмене ордера:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Внутренняя ошибка сервера'
        });
    }
});

// Модифицируем endpoint для получения ордеров
app.get('/get-latest-orders', async (req, res) => {
  try {
    const orders = await getLatestOrders();
    res.json({
      success: true,
      orders: orders
    });
  } catch (error) {
    console.error('Error fetching latest orders:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Функция получения ордеров
async function getLatestOrders() {
  console.log('Fetching latest orders...');

  try {
    // Получаем открытые ордера
    const openOrdersResult = await client.listOrders({
      limit: "350",  // Увеличено с 250 до 350
      order_status: ["OPEN"]
    });
    console.log('Open orders result received');

    // Получаем исполненные и отмененные ордера
    const otherOrdersResult = await client.listOrders({
      limit: "350",  // Увеличено с 250 до 350
      order_status: ["FILLED", "CANCELLED"]
    });
    console.log('Other orders result received');

    // Парсим результаты
    const openOrders = typeof openOrdersResult === 'string' ? JSON.parse(openOrdersResult) : openOrdersResult;
    const otherOrders = typeof otherOrdersResult === 'string' ? JSON.parse(otherOrdersResult) : otherOrdersResult;

    // Объединяем все ордера
    const allOrders = [
      ...(openOrders.orders || []),
      ...(otherOrders.orders || [])
    ];

    console.log('Combined orders count:', allOrders.length);

    // Проверяем, что у всех ордеров есть created_time или time_placed
    allOrders.forEach(order => {
      // Используем time_placed, если оно есть, иначе created_time
      if (!order.time_placed && !order.created_time) {
        console.warn('Order without time_placed or created_time:', order);
        order.time_placed = new Date().toISOString(); // Устанавливаем текущее время
      }
    });

    // Сортируем по убыванию даты (новые первыми)
    allOrders.sort((a, b) => {
      // Используем time_placed для сортировки, если оно есть, иначе created_time
      const timeA = new Date(a.time_placed || a.created_time).getTime();
      const timeB = new Date(b.time_placed || b.created_time).getTime();

      // Проверяем, что даты валидны
      if (isNaN(timeA)) {
        console.warn('Invalid date A:', a.time_placed || a.created_time);
        return 1; // Помещаем невалидные даты в конец
      }
      if (isNaN(timeB)) {
        console.warn('Invalid date B:', b.time_placed || b.created_time);
        return -1; // Помещаем невалидные даты в конец
      }

      // Сравниваем даты (новые первыми)
      return timeB - timeA;
    });

    // Логируем первые несколько ордеров для проверки сортировки
    console.log('First 5 orders after sorting:');
    allOrders.slice(0, 5).forEach((order, index) => {
      console.log(`Order ${index + 1}: ${order.order_id}, Time Placed: ${order.time_placed || order.created_time}`);
    });

    // Ограничиваем количество ордеров до 700
    const limitedOrders = allOrders.slice(0, 700);

    // Форматируем ордера для отображения
    const formattedOrders = limitedOrders.map(formatOrder);

    return formattedOrders;
  } catch (error) {
    console.error('Error fetching orders:', error);
    return []; // Возвращаем пустой массив в случае ошибки
  }
}

// Обновим функцию форматирования ордера для поддержки Stop Limit
function formatOrder(order) {
  const orderConfig = order.order_configuration || {};
  const isStopLimit = orderConfig.stop_limit_stop_limit_gtc;
  const isMarket = orderConfig.market_market_ioc;
  
  // Получаем конфигурацию в зависимости от типа ордера
  let config;
  if (isStopLimit) {
    config = orderConfig.stop_limit_stop_limit_gtc;
  } else if (isMarket) {
    config = orderConfig.market_market_ioc;
  } else {
    config = orderConfig.limit_limit_gtc;
  }

  // Используем time_placed, если оно есть, иначе created_time
  let timePlaced = order.time_placed || order.created_time;
  if (timePlaced) {
    // Убедимся, что дата в формате ISO
    try {
      const date = new Date(timePlaced);
      if (!isNaN(date.getTime())) {
        timePlaced = date.toISOString();
      }
    } catch (e) {
      console.warn('Error formatting date:', e);
    }
  } else {
    timePlaced = new Date().toISOString();
  }

  // Вычисляем процент заполнения
  let orderSize = 0;
  let completionPercentage = 0;
  
  if (isMarket) {
    // Для market ордеров нужно сравнивать в одинаковых единицах
    if (order.side === 'BUY') {
      // Для buy market ордеров сравниваем потраченную сумму с запланированной
      const quoteSize = parseFloat(config?.quote_size || '0');
      const totalValue = parseFloat(order.total_value_after_fees || '0');
      orderSize = quoteSize;
      if (orderSize > 0) {
        completionPercentage = parseFloat(((totalValue / orderSize) * 100).toFixed(2));
      }
    } else {
      // Для sell market ордеров сравниваем количество монет
      orderSize = parseFloat(config?.base_size || '0');
      const filledSize = parseFloat(order.filled_size || '0');
      if (orderSize > 0) {
        completionPercentage = parseFloat(((filledSize / orderSize) * 100).toFixed(2));
      }
    }
  } else {
    // Для limit и stop-limit ордеров используем base_size
    orderSize = parseFloat(config?.base_size || '0');
    const filledSize = parseFloat(order.filled_size || '0');
    if (orderSize > 0) {
      completionPercentage = parseFloat(((filledSize / orderSize) * 100).toFixed(2));
    }
  }
  
  // Улучшенная fallback логика
if (completionPercentage === 0) {
  const filledSize = parseFloat(order.filled_size || '0');
  
  if (filledSize > 0) {
    // Если есть заполненный размер, но нет orderSize из конфигурации
    // пытаемся использовать альтернативные поля
    const alternativeOrderSize = parseFloat(order.size || order.order_size || '0');
    
    if (alternativeOrderSize > 0) {
      completionPercentage = parseFloat(((filledSize / alternativeOrderSize) * 100).toFixed(2));
      orderSize = alternativeOrderSize;
    } else if (order.status === 'FILLED') {
      // Если ордер полностью исполнен, но мы не можем определить размер
      completionPercentage = 100;
      orderSize = filledSize;
    } else {
      // Для частично исполненных ордеров без размера показываем что-то разумное
      completionPercentage = 50; // Примерное значение
      orderSize = filledSize * 2; // Примерная оценка
    }
  }
}

// Ограничиваем процент до 100%
if (completionPercentage > 100) {
  completionPercentage = 100;
}

// Убеждаемся, что у нас есть разумное значение orderSize
if (orderSize === 0 && parseFloat(order.filled_size || '0') > 0) {
  orderSize = parseFloat(order.filled_size || '0');
}

  return {
    order_id: order.order_id,
    product_id: order.product_id,
    side: order.side,
    order_type: isStopLimit ? 'STOP_LIMIT' : (isMarket ? 'MARKET' : 'LIMIT'),
    status: order.status,
    created_time: timePlaced, // Используем time_placed вместо created_time
    order_size: orderSize.toString(), // Используем то же значение, что и для расчета процента
    filled_size: order.filled_size || '0.00000000',
    limit_price: config?.limit_price || '0.00000000',
    stop_price: isStopLimit ? config?.stop_price : null,
    average_filled_price: order.average_filled_price || '0.00000000',
    total_value: order.total_value_after_fees || '0.00000000',
    completion_percentage: completionPercentage, // Используем вычисленный процент
    total_fees: order.total_fees || '0.00000000'
  };
}

// Запускаем периодическое обновление
setInterval(async () => {
  try {
    const orders = await getLatestOrders();
    console.log('Periodic update - orders count:', orders.length);
    broadcastOrders(orders);
  } catch (error) {
    console.error('Error in orders update interval:', error);
  }
}, 1000); // Увеличим интервал до 1 секунды

// Добавьте этот маршрут в server.js
app.get('/get-coin-balance/:coin', async (req, res) => {
  try {
    const coin = (req.params.coin || '').toUpperCase();

    // Загружаем все аккаунты (числовое значение limit)
    const response = await client.listAccounts({ limit: 250 });
    const accountsData = typeof response === 'string' ? JSON.parse(response) : response;
    const accounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : [];

    // Ищем сначала по currency
    let account = accounts.find(acc => String(acc.currency || '').toUpperCase() === coin);

    // Для USDC — проверяем также name (часто "USD Coin")
    if (!account && coin === 'USDC') {
      account = accounts.find(acc => String(acc.name || '').toUpperCase().includes('USD COIN'));
    }

    // Общий fallback: поиск по name, если currency не совпала
    if (!account) {
      account = accounts.find(acc => String(acc.name || '').toUpperCase().includes(coin));
    }

    if (account) {
      const available = parseFloat(account?.available_balance?.value ?? '0') || 0;
      const hold = parseFloat(account?.hold?.value ?? '0') || 0;
      const total = available + hold;

      // Возвращаем обе метрики, чтобы фронт мог решить, что показывать
      res.json({
        success: true,
        currency: account.currency || coin,
        balance: available.toString(),
        hold: hold.toString(),
        total: total.toString(),
        accountName: account.name || ''
      });
    } else {
      res.json({ success: true, balance: '0', hold: '0', total: '0' });
    }
  } catch (error) {
    console.error('Error getting coin balance:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Добавьте также маршрут для получения текущей цены
app.get('/api/price', async (req, res) => {
  try {
    const coin = req.query.coin;
    if (!coin) {
      return res.json({
        success: false,
        error: 'Coin parameter is required'
      });
    }

    // Здесь должен быть код для получения цены из API Coinbase
    // Для тестирования вернем фиктивные данные
    const mockPrices = {
      'BTC': { price: 50000, bestBid: 49950, bestAsk: 50050 },
      'ETH': { price: 3000, bestBid: 2990, bestAsk: 3010 },
      'SOL': { price: 127.5, bestBid: 127.4, bestAsk: 127.6 },
      'DOGE': { price: 0.1, bestBid: 0.099, bestAsk: 0.101 }
    };

    const priceData = mockPrices[coin] || { price: 0, bestBid: 0, bestAsk: 0 };

    res.json({
      success: true,
      ...priceData
    });
  } catch (error) {
    console.error('Error getting price:', error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

// Обновляем endpoint для получения лузеров
app.get('/api/monthly-losers', async (req, res) => {
  try {
    console.log('Starting monthly losers request...');
    const losers = await getMonthlyLosers();

    if (!losers) {
      console.error('No data returned from getMonthlyLosers');
      return res.status(500).json({
        success: false,
        error: 'No data available'
      });
    }

    console.log(`Successfully found ${losers.length} losers`);
    res.json({
      success: true,
      data: losers,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('Error in /api/monthly-losers:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Обновим endpoint для получения лузеров
app.get('/get-losers-data', async (req, res) => {
  try {
    console.log('Starting losers data request...');

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), 120000)
    );

    const losersPromise = getMonthlyLosers();

    const losers = await Promise.race([losersPromise, timeoutPromise])
      .catch(error => {
        console.error('Error or timeout:', error.message);
        return [];
      });

    console.log(`Request complete. Found ${losers.length} losers`);

    // Добавляем timestamp к данным
    const response = {
      success: true,
      data: losers,
      timestamp: Date.now(),
      lastUpdate: new Date().toISOString()
    };

    res.json(response);

  } catch (error) {
    console.error('Error in /get-losers-data:', error);
    res.json({
      success: true,
      data: [],
      message: error.message,
      timestamp: Date.now()
    });
  }
});

// Добавьте в начало файла
const volumeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 минут

// Оптимизированный эндпоинт с кэшированием
app.get('/get-volume-data', async (req, res) => {
  const coinSymbol = req.query.coin;

  if (!coinSymbol) {
    return res.json({
      success: false,
      error: 'Coin symbol is required'
    });
  }

  try {
    // Проверяем кэш
    const cacheKey = coinSymbol.toUpperCase();
    const cachedData = volumeCache.get(cacheKey);

    if (cachedData && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
      console.log(`Using cached data for ${coinSymbol}`);
      return res.json({
        success: true,
        data: cachedData.data,
        cached: true
      });
    }

    console.log(`Getting volume data for ${coinSymbol}...`);

    // Запускаем браузер с оптимизированными настройками
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--safebrowsing-disable-auto-update'
      ]
    });

    const page = await browser.newPage();

    // Отключаем загрузку изображений, шрифтов и CSS для ускорения
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.resourceType() === 'image' || req.resourceType() === 'font' || req.resourceType() === 'stylesheet') {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Устанавливаем таймаут для навигации
    page.setDefaultNavigationTimeout(30000);

    // Открываем страницу Coinbase с оптимизированными параметрами
    await page.goto(`https://exchange.coinbase.com/trade/${coinSymbol}-USD`, {
      waitUntil: 'domcontentloaded', // Быстрее, чем 'networkidle2'
      timeout: 30000
    });

    // Ждем только необходимые селекторы вместо всей страницы
    const volumeSelector = '#page_content > div > div > div > div > div:nth-child(2) > div:nth-child(2) > div:first-child > div:nth-child(2) > div:nth-child(3) > span:first-child';
    const priceSelector = '#page_content > div > div > div > div > div:nth-child(2) > div:nth-child(2) > div:first-child > div:nth-child(2) > div:first-child > span:first-child';

    // Используем Promise.all для параллельного ожидания элементов
    await Promise.all([
      page.waitForSelector(volumeSelector, { timeout: 20000 }),
      page.waitForSelector(priceSelector, { timeout: 20000 })
    ]).catch(e => console.warn('Warning: One or more selectors not found:', e.message));

    // Получаем данные объема и цены
    const volumeData = await page.evaluate((volumeSelector, priceSelector) => {
      // Получаем элементы
      const volumeElement = document.querySelector(volumeSelector);
      const priceElement = document.querySelector(priceSelector);

      if (!volumeElement || !priceElement) {
        return { error: 'Elements not found' };
      }

      // Извлекаем числа
      const extractNumber = (text) => {
        const match = text.match(/^([\d,]+)/);
        if (match) {
          return parseFloat(match[1].replace(/,/g, ''));
        }
        return null;
      };

      // Функция для форматирования чисел в K, M, B
      const formatNumber = (num) => {
        if (num >= 1000000000) {
          return (num / 1000000000).toFixed(1) + ' B';
        } else if (num >= 1000000) {
          return (num / 1000000).toFixed(1) + ' M';
        } else if (num >= 1000) {
          return (num / 1000).toFixed(1) + ' K';
        } else {
          return num.toFixed(2);
        }
      };

      const volume = extractNumber(volumeElement.textContent);
      const price = priceElement.textContent.trim();

      if (volume === null) {
        return { error: 'Failed to extract volume number' };
      }

      // Вычисляем total volume in USD
      const totalVolumeUSD = volume * parseFloat(price);

      return {
        volume24h: volumeElement.textContent,
        price: price,
        totalVolumeUSD: formatNumber(totalVolumeUSD),
        rawTotalVolumeUSD: totalVolumeUSD // Сохраняем также необработанное значение
      };
    }, volumeSelector, priceSelector);

    // Закрываем браузер
    await browser.close();

    if (volumeData.error) {
      return res.json({
        success: false,
        error: volumeData.error
      });
    }

    // Сохраняем результат в кэш
    volumeCache.set(cacheKey, {
      data: volumeData,
      timestamp: Date.now()
    });

    // Возвращаем результат
    return res.json({
      success: true,
      data: volumeData,
      cached: false
    });

  } catch (error) {
    console.error('Error getting volume data:', error);
    return res.json({
      success: false,
      error: error.message
    });
  }
});

// Добавьте функцию для поиска свободного порта
function findAvailablePort(startPort, maxAttempts = 10) {
  return new Promise((resolve, reject) => {
    let currentPort = startPort;
    let attempts = 0;

    function tryPort(port) {
      if (attempts >= maxAttempts) {
        return reject(new Error(`Could not find an available port after ${maxAttempts} attempts`));
      }

      const testServer = http.createServer();
      testServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`Port ${port} is in use, trying ${port + 1}...`);
          attempts++;
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });

      testServer.once('listening', () => {
        testServer.close(() => {
          resolve(port);
        });
      });

      testServer.listen(port);
    }

    tryPort(currentPort);
  });
}

// Используем функцию для запуска сервера на свободном порту
const preferredPort = process.env.PORT || 3005;

findAvailablePort(preferredPort)
  .then(port => {
    server.listen(port, () => {
      console.log(`Server running on http://localhost:${port}`);
    });
  })
  .catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });

// Новый endpoint для сохранения выбранных заказов
app.post('/save-selected-orders', (req, res) => {
  try {
    const { orderIds } = req.body;
    if (Array.isArray(orderIds)) {
      selectedOrderIds = orderIds;
      saveSelectedOrdersToFile(selectedOrderIds); // Добавляем сохранение в файл
      console.log('Selected orders saved:', selectedOrderIds);
      res.json({ success: true, message: 'Selected orders saved successfully' });
    } else {
      res.status(400).json({ success: false, message: 'Invalid orderIds format' });
    }
  } catch (error) {
    console.error('Error saving selected orders:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Эндпоинт для получения ID выбранных ордеров
app.get('/get-selected-orders-ids', (req, res) => {
  try {
    console.log('Returning selected order IDs:', selectedOrderIds);
    res.json({
      success: true,
      orderIds: selectedOrderIds
    });
  } catch (error) {
    console.error('Error getting selected order IDs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get selected order IDs'
    });
  }
});

// Эндпоинт для получения данных выбранных ордеров
app.post('/get-selected-orders-data', async (req, res) => {
  try {
    const { selectedOrderIds } = req.body;
    
    if (!Array.isArray(selectedOrderIds)) {
      return res.status(400).json({
        success: false,
        message: 'selectedOrderIds must be an array'
      });
    }

    console.log('Getting data for selected orders:', selectedOrderIds);
    
    const latestOrders = await getLatestOrders();
    
    // Фильтруем заказы по выбранным ID
    const selectedOrders = latestOrders.filter(order => 
      selectedOrderIds.includes(order.order_id)
    );

    console.log('Found selected orders:', selectedOrders.length);

    // Группируем по монетам
    const coinGroups = {};
    selectedOrders.forEach(order => {
      const coin = order.product_id;
      if (!coinGroups[coin]) {
        coinGroups[coin] = {
          orders: [],
          totalFilledSize: 0,
          totalValue: 0
        };
      }
      coinGroups[coin].orders.push(order);
      coinGroups[coin].totalFilledSize += parseFloat(order.filled_size || 0);
      coinGroups[coin].totalValue += parseFloat(order.filled_size || 0) * parseFloat(order.average_filled_price || order.limit_price || 0);
    });

    // Функция для получения текущей цены с повторными попытками
    async function getCurrentPrice(pair, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(`Getting price for ${pair}, attempt ${attempt}`);
          const response = await fetch(`https://api.exchange.coinbase.com/products/${pair}/ticker`);
          if (!response.ok) {
            console.warn(`HTTP ${response.status} for ${pair}, attempt ${attempt}`);
            if (attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Увеличивающаяся задержка
              continue;
            }
            throw new Error(`HTTP ${response.status}`);
          }
          
          const data = await response.json();
          const askPrice = data && data.ask ? parseFloat(data.ask) : null;
          
          // Проверяем что цена валидна и больше нуля
          if (askPrice && askPrice > 0) {
            console.log(`Price for ${pair}: $${askPrice}`);
            return askPrice;
          } else {
            console.warn(`Invalid price for ${pair}: ${askPrice}, attempt ${attempt}`);
            if (attempt < retries) {
              await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
              continue;
            }
          }
        } catch (error) {
          console.error(`Error getting price for ${pair}, attempt ${attempt}:`, error.message);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            continue;
          }
        }
      }
      
      console.error(`Failed to get valid price for ${pair} after ${retries} attempts`);
      return null;
    }

    // Преобразуем в формат для Telegram бота с расчетом profitLimit
    const coins = await Promise.all(Object.keys(coinGroups).map(async coinPair => {
      const group = coinGroups[coinPair];
      
      // Получаем текущую цену с повторными попытками
      const currentPrice = await getCurrentPrice(coinPair, 3);
      
      let profitLimit = 0;
      if (currentPrice && currentPrice > 0 && group.totalFilledSize > 0 && group.totalValue > 0) {
        // Расчет как в scripts.js
        const PROFIT_LIMIT_FEE = 0.0025; // 0.25% комиссия для Profit Limit
        const potentialValue = currentPrice * group.totalFilledSize;
        const afterFees = potentialValue * (1 - PROFIT_LIMIT_FEE);
        profitLimit = afterFees - group.totalValue;
        
        console.log(`Profit calculation for ${coinPair}: price=${currentPrice}, size=${group.totalFilledSize}, value=${group.totalValue}, profit=${profitLimit.toFixed(2)}`);
      } else {
        console.warn(`Cannot calculate profit for ${coinPair}: price=${currentPrice}, size=${group.totalFilledSize}, value=${group.totalValue}`);
      }
      
      return {
        coin: coinPair,
        orders: group.orders,
        totalFilledSize: group.totalFilledSize,
        totalValue: group.totalValue,
        profitLimit: profitLimit.toFixed(2),
        profit: profitLimit.toFixed(2) // для совместимости
      };
    }));

    res.json({
      success: true,
      coins: coins
    });
  } catch (error) {
    console.error('Error getting selected orders data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get selected orders data'
    });
  }
});

// Эндпоинт для массовой отмены ордеров
app.post('/cancel-multiple-orders', async (req, res) => {
  try {
    const { orderIds } = req.body;
    console.log('Cancelling multiple orders:', orderIds);
    
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'orderIds array is required and must not be empty'
      });
    }
    
    // Отправляем запрос на отмену ордеров
    const result = await client.cancelOrders({
      orderIds: orderIds
    });
    
    console.log('Cancel multiple orders response:', result);
    
    // Проверяем результат
    if (!result) {
      throw new Error('Нет ответа от Coinbase API');
    }
    
    // Подсчитываем успешные и неуспешные отмены
    let successCount = 0;
    let failureCount = 0;
    const failures = [];
    
    if (result.results && result.results.length > 0) {
      result.results.forEach((cancelResult, index) => {
        if (cancelResult.success === false) {
          failureCount++;
          let errorMessage;
          if (typeof cancelResult.failure_reason === 'object') {
            errorMessage = cancelResult.failure_reason?.message || 
                          cancelResult.failure_reason?.error_details || 
                          JSON.stringify(cancelResult.failure_reason);
          } else {
            errorMessage = cancelResult.failure_reason || 'Неизвестная ошибка';
          }
          failures.push({
            orderId: orderIds[index],
            error: errorMessage
          });
        } else {
          successCount++;
        }
      });
    } else {
      // Если нет results, считаем что все ордера отменены успешно
      successCount = orderIds.length;
    }
    
    res.json({
      success: true,
      message: `Отменено ордеров: ${successCount}, ошибок: ${failureCount}`,
      successCount: successCount,
      failureCount: failureCount,
      failures: failures,
      totalRequested: orderIds.length
    });
    
  } catch (error) {
    console.error('Ошибка при массовой отмене ордеров:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Внутренняя ошибка сервера'
    });
  }
});

// ═══════════════════════════════════════════
// PROXY: Forward to root server (port 3847) for profit & holdings
// ═══════════════════════════════════════════
const ROOT_SERVER = 'http://localhost:3847';

app.get('/get-profit-history', async (req, res) => {
  try {
    const r = await fetch(`${ROOT_SERVER}/get-profit-history`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/get-holdings', async (req, res) => {
  try {
    const r = await fetch(`${ROOT_SERVER}/get-holdings`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});
