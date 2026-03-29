import { saveFullOrderDataToFirestore } from './firestore-database.js';

// Тестовые данные ордеров
const testOrders = [
    {
        order_id: 'a32c522d-d8b7-43cd-85f3-c13e37872fa8',
        product_id: 'LOKA-USD',
        side: 'buy',
        size: '2710.94',
        price: '0.1709',
        status: 'filled',
        created_time: '2024-01-20T10:30:00Z',
        filled_size: '2710.94',
        completion_percentage: 100,
        fees: '4.63'
    },
    {
        order_id: 'b45d633e-e9c8-54de-96f4-d24f48983fb9',
        product_id: 'BTC-USD',
        side: 'buy',
        size: '0.001',
        price: '45000.00',
        status: 'OPEN',
        created_time: '2024-01-20T11:15:00Z',
        filled_size: '0.0005',
        completion_percentage: 50,
        fees: '0.45'
    },
    {
        order_id: 'c56e744f-f0d9-65ef-a7g5-e35g59094gc0',
        product_id: 'ETH-USD',
        side: 'sell',
        size: '0.1',
        price: '2800.00',
        status: 'FILLED',
        created_time: '2024-01-20T12:00:00Z',
        filled_size: '0.1',
        completion_percentage: 100,
        fees: '2.80'
    }
];

// Функция для загрузки данных в Firestore
window.loadFirestoreTestData = async function() {
    try {
        console.log('🚀 Загружаем тестовые данные в Firestore...');
        
        for (const order of testOrders) {
            await saveFullOrderDataToFirestore(order);
            console.log(`✅ Ордер ${order.order_id} сохранен в Firestore`);
        }
        
        console.log('✅ Все тестовые данные загружены в Firestore!');
        alert('Тестовые данные успешно загружены в Firestore!');
        
        // Перезагружаем страницу для обновления данных
        window.location.reload();
    } catch (error) {
        console.error('❌ Ошибка загрузки данных:', error);
        alert('Ошибка при загрузке данных: ' + error.message);
    }
};