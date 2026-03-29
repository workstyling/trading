// Используем Firebase CDN версию
// Убедитесь, что в index.html подключены скрипты Firebase:
// <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js"></script>

const firebaseConfig = {
  apiKey: "AIzaSyDIIltVePgW4gnh63hJjH3To5HompaHYiU",
  authDomain: "tradingcryptodata.firebaseapp.com",
  databaseURL: "https://tradingcryptodata-default-rtdb.firebaseio.com",
  projectId: "tradingcryptodata",
  storageBucket: "tradingcryptodata.firebasestorage.app",
  messagingSenderId: "714924244385",
  appId: "1:714924244385:web:1f4f2f51d85c59d9f3dfe0"
};

// Инициализация Firebase с отладкой
console.log('🔥 Initializing Firebase...');
console.log('🔥 Firebase available:', typeof firebase !== 'undefined');

if (typeof firebase === 'undefined') {
  console.error('❌ Firebase is not loaded! Check CDN scripts in index.html');
  throw new Error('Firebase is not loaded');
}

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
  console.log('✅ Firebase initialized successfully');
} else {
  console.log('✅ Firebase already initialized');
}

const database = firebase.database();
console.log('✅ Database reference created:', database);

export function createOrdersTable(orderData) {
  const tableHTML = `
    <div class="price-table-container mt-4">
      <table class="price-table w-full border-collapse mb-3">
        <thead>
          <tr>
            <th class="px-2">Date</th>
            <th class="px-2">Coin</th>
            <th class="px-2">Base Size</th>
            <th class="px-2">Limit Price</th>
            <th class="px-2">Total USD</th>
            <th class="px-2">Order ID</th>
            <th class="px-2">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="border px-2 py-1 text-center">
              ${new Date().toLocaleString()}
            </td>
            <td class="border px-2 py-1 text-center font-bold">
              ${orderData.coin}
            </td>
            <td class="border px-2 py-1 text-center">
              ${orderData.baseSize}
            </td>
            <td class="border px-2 py-1 text-center">
              $${orderData.limitPrice}
            </td>
            <td class="border px-2 py-1 text-center">
              $${(
                parseFloat(orderData.baseSize) *
                parseFloat(orderData.limitPrice)
              ).toFixed(2)}
            </td>
            <td class="border px-2 py-1 text-center">
              ${orderData.orderId || 'Pending...'}
            </td>
            <td class="border px-2 py-1 text-center">
              <span class="status-pending">Pending</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
  return tableHTML;
}

export async function saveSelectedOrders(selectedOrderIds) {
  try {
    console.log('🚀 Starting to save selected orders:', selectedOrderIds);
    console.log('🔗 Database reference:', database);
    
    const selectedOrdersRef = database.ref('selected-orders');
    console.log('📍 Reference created:', selectedOrdersRef.toString());
    
    const dataToSave = {
      orderIds: selectedOrderIds,
      updated_at: firebase.database.ServerValue.TIMESTAMP
    };
    console.log('💾 Data to save:', dataToSave);
    
    await selectedOrdersRef.set(dataToSave);
    console.log('✅ Selected orders saved to Firebase successfully:', selectedOrderIds);
    
    // Проверяем, что данные действительно сохранились
    const snapshot = await selectedOrdersRef.once('value');
    console.log('🔍 Verification - data in Firebase:', snapshot.val());
    
  } catch (error) {
    console.error('❌ Error saving selected orders to Firebase:', error);
    console.error('❌ Error details:', {
      code: error.code,
      message: error.message,
      stack: error.stack
    });
    throw error;
  }
}

export async function saveOrder(orderData) {
  try {
    const ordersRef = database.ref('orders');
    const newOrderRef = ordersRef.push();
    
    const orderWithTimestamp = {
      ...orderData,
      created_at: firebase.database.ServerValue.TIMESTAMP
    };
    
    await newOrderRef.set(orderWithTimestamp);
    console.log('Order saved to Firebase with key:', newOrderRef.key);
    return newOrderRef.key;
  } catch (error) {
    console.error('Error saving order to Firebase:', error);
    throw error;
  }
}

export async function loadSelectedOrdersFromFirebase() {
  try {
    console.log('🔥 Loading selected orders from Firebase...');
    
    const selectedOrdersRef = database.ref('selected-orders');
    const snapshot = await selectedOrdersRef.once('value');
    const data = snapshot.val();
    
    if (data && Array.isArray(data.orderIds)) {
      console.log('✅ Selected orders loaded from Firebase:', data.orderIds);
      console.log('📅 Last updated:', new Date(data.updated_at));
      return {
        success: true,
        orderIds: data.orderIds,
        updated_at: data.updated_at
      };
    } else {
      console.log('ℹ️ No selected orders found in Firebase');
      return {
        success: true,
        orderIds: []
      };
    }
  } catch (error) {
    console.error('❌ Error loading selected orders from Firebase:', error);
    return {
      success: false,
      error: error.message,
      orderIds: []
    };
  }
}
