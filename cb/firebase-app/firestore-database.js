// Firestore Database Functions
const firebaseConfig = {
  apiKey: "AIzaSyDIIltVePgW4gnh63hJjH3To5HompaHYiU",
  authDomain: "tradingcryptodata.firebaseapp.com",
  databaseURL: "https://tradingcryptodata-default-rtdb.firebaseio.com",
  projectId: "tradingcryptodata",
  storageBucket: "tradingcryptodata.firebasestorage.app",
  messagingSenderId: "714924244385",
  appId: "1:714924244385:web:1f4f2f51d85c59d9f3dfe0"
};

// Инициализация Firebase
console.log('🔥 Initializing Firebase with Firestore...');

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

const db = firebase.firestore();
console.log('✅ Firestore reference created:', db);

// Функция для сохранения выбранных ордеров в Firestore
export async function saveSelectedOrdersToFirestore(orderIds) {
    try {
        console.log('💾 Saving selected orders to Firestore:', orderIds);
        
        const docRef = db.collection('selected-orders').doc('current');
        
        await docRef.set({
            orderIds: orderIds,
            updated_at: firebase.firestore.FieldValue.serverTimestamp(),
            count: orderIds.length
        });
        
        console.log('✅ Selected orders saved to Firestore successfully');
        return { success: true };
    } catch (error) {
        console.error('❌ Error saving selected orders to Firestore:', error);
        return { success: false, error: error.message };
    }
}

// Функция для загрузки выбранных ордеров из Firestore
export async function loadSelectedOrdersFromFirestore() {
    try {
        console.log('📥 Loading selected orders from Firestore...');
        
        const docRef = db.collection('selected-orders').doc('current');
        const doc = await docRef.get();
        
        if (doc.exists) {
            const data = doc.data();
            console.log('✅ Selected orders loaded from Firestore:', data);
            return {
                success: true,
                orderIds: data.orderIds || [],
                updated_at: data.updated_at,
                count: data.count || 0
            };
        } else {
            console.log('📭 No selected orders found in Firestore');
            return {
                success: true,
                orderIds: [],
                updated_at: null,
                count: 0
            };
        }
    } catch (error) {
        console.error('❌ Error loading selected orders from Firestore:', error);
        return { success: false, error: error.message };
    }
}

// Функция для сохранения полных данных ордера в Firestore
export async function saveFullOrderDataToFirestore(orderData) {
    try {
        console.log('💾 Saving full order data to Firestore:', orderData.order_id);
        
        const docRef = db.collection('orders').doc(orderData.order_id);
        
        await docRef.set({
            ...orderData,
            updated_at: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        console.log('✅ Full order data saved to Firestore successfully');
        return { success: true };
    } catch (error) {
        console.error('❌ Error saving full order data to Firestore:', error);
        return { success: false, error: error.message };
    }
}

// Функция для загрузки полных данных ордеров из Firestore
export async function loadAllOrdersFromFirestore() {
    try {
        console.log('📥 Loading all orders from Firestore...');
        
        const querySnapshot = await db.collection('orders').get();
        const orders = [];
        
        querySnapshot.forEach((doc) => {
            orders.push({
                id: doc.id,
                ...doc.data()
            });
        });
        
        console.log('✅ All orders loaded from Firestore:', orders.length);
        return {
            success: true,
            orders: orders
        };
    } catch (error) {
        console.error('❌ Error loading orders from Firestore:', error);
        return { success: false, error: error.message };
    }
}

// Экспортируем db для использования в других файлах
window.firestoreDb = db;