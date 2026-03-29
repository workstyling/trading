// Скрипт для загрузки данных в Firebase
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// Инициализация Firebase Admin SDK
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://tradingcryptodata-default-rtdb.firebaseio.com/"
});

const database = admin.database();

async function uploadSelectedOrdersData() {
  try {
    // Читаем данные из локального сервера (ИСПРАВЛЕН ПОРТ)
    const response = await fetch('http://localhost:3005/get-selected-orders-ids');
    const idsData = await response.json();
    
    if (!idsData.success || !idsData.orderIds.length) {
      console.log('No selected orders found');
      return;
    }
    
    // Получаем полные данные ордеров (ИСПРАВЛЕН ПОРТ)
    const ordersResponse = await fetch('http://localhost:3005/get-selected-orders-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedOrderIds: idsData.orderIds })
    });
    
    const ordersData = await ordersResponse.json();
    
    if (ordersData.success) {
      // Загружаем данные в Firebase
      await database.ref('selected-orders/data').set({
        coins: ordersData.coins,
        lastUpdated: new Date().toISOString()
      });
      
      console.log('Data uploaded to Firebase successfully!');
    }
  } catch (error) {
    console.error('Error uploading data to Firebase:', error);
  }
}

// Запускаем загрузку
uploadSelectedOrdersData();