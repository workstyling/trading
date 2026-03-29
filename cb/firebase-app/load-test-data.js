// Загрузка тестовых данных в Firebase
import { saveSelectedOrders } from './database.js';

// Тестовые данные ордеров
const testOrderIds = [
    'a32c522d-d8b7-43cd-85f3-c13e37872fa8',
    'b45d633e-e9c8-54de-96f4-d24f48983fb9',
    'c56e744f-f0d9-65ef-a7g5-e35g59094gc0'
];

// Функция для загрузки тестовых данных
window.loadTestData = async function() {
    try {
        console.log('🚀 Загружаем тестовые данные в Firebase...');
        await saveSelectedOrders(testOrderIds);
        console.log('✅ Тестовые данные успешно загружены!');
        
        // Обновляем страницу для отображения данных
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        
    } catch (error) {
        console.error('❌ Ошибка загрузки тестовых данных:', error);
        alert('Ошибка загрузки данных: ' + error.message);
    }
};

// Функция для очистки данных
window.clearTestData = async function() {
    try {
        console.log('🧹 Очищаем данные в Firebase...');
        await saveSelectedOrders([]);
        console.log('✅ Данные успешно очищены!');
        
        // Обновляем страницу
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        
    } catch (error) {
        console.error('❌ Ошибка очистки данных:', error);
        alert('Ошибка очистки данных: ' + error.message);
    }
};