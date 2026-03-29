import { saveFullOrderData, saveSelectedOrders } from './database.js';

// Полные тестовые данные ордеров
const testOrders = [
    {
        order_id: 'a32c522d-d8b7-43cd-85f3-c13e37872fa8',
        product_id: 'BTC-USD',
        side: 'buy',
        size: '0.001',
        price: '45000.00',
        status: 'OPEN',
        created_time: '2024-01-20T10:30:00Z',
        filled_size: '0.0005',
        completion_percentage: 50,
        fees: '0.45'
    },
    {
        order_id: 'b45d633e-e9c8-54de-96f4-d24f48983fb9',
        product_id: 'ETH-USD', 
        side: 'sell',
        size: '0.1',
        price: '2800.00',
        status: 'FILLED',
        created_time: '2024-01-20T11:15:00Z',
        filled_size: '0.1',
        completion_percentage: 100,
        fees: '2.80'
    },
    {
        order_id: 'c56e744f-f0d9-65ef-a7g5-e35g59094gc0',
        product_id: 'ADA-USD',
        side: 'buy', 
        size: '100',
        price: '0.45',
        status: 'OPEN',
        created_time: '2024-01-20T12:00:00Z',
        filled_size: '25',
        completion_percentage: 25,
        fees: '0.11'
    }
];

// Функция для загрузки полных тестовых данных
window.loadFullTestData = async function() {
    try {
        console.log('🚀 Загружаем полные тестовые данные в Firebase...');
        
        // Сохраняем каждый ордер в раздел orders
        for (const order of testOrders) {
            await saveFullOrderData(order);
            console.log('✅ Ордер сохранен:', order.order_id);
        }
        
        // Сохраняем список выбранных ордеров
        const orderIds = testOrders.map(order => order.order_id);
        await saveSelectedOrders(orderIds);
        
        console.log('✅ Все тестовые данные успешно загружены!');
        alert('Тестовые данные загружены! Обновляю страницу...');
        
        // Обновляем страницу для отображения данных
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        
    } catch (error) {
        console.error('❌ Ошибка загрузки тестовых данных:', error);
        alert('Ошибка загрузки данных: ' + error.message);
    }
};

// Функция для очистки всех данных
window.clearAllData = async function() {
    try {
        console.log('🧹 Очищаем все данные в Firebase...');
        
        // Очищаем выбранные ордера
        await saveSelectedOrders([]);
        
        // Очищаем раздел orders (нужно добавить функцию в database.js)
        const { database } = await import('./database.js');
        await database.ref('orders').remove();
        
        console.log('✅ Все данные успешно очищены!');
        alert('Данные очищены! Обновляю страницу...');
        
        // Обновляем страницу
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        
    } catch (error) {
        console.error('❌ Ошибка очистки данных:', error);
        alert('Ошибка очистки данных: ' + error.message);
    }
};