// Константы комиссий
window.FEES = {
    PROFIT_LIMIT: 0.0007,
    PROFIT_MARKET: 0.0016
};

// Основная логика приложения
async function loadSelectedOrders() {
    try {
        console.log('Загружаем выбранные ордера из Firebase...');
        
        // Проверяем, что Firebase инициализирован
        if (typeof database === 'undefined') {
            throw new Error('Firebase database не инициализирован');
        }
        
        // Загружаем данные ордеров из Firebase
        const ordersSnapshot = await database.ref('selected-orders').once('value');
        const ordersData = ordersSnapshot.val();
        
        console.log('Данные из Firebase:', ordersData);
        
        if (ordersData && ordersData.orderIds && Array.isArray(ordersData.orderIds) && ordersData.orderIds.length > 0) {
            console.log('Найдено ордеров:', ordersData.orderIds.length);
            displaySelectedOrderIds({
                orderIds: ordersData.orderIds,
                timestamp: ordersData.updated_at || new Date().toISOString(),
                count: ordersData.orderIds.length
            });
        } else {
            console.log('Данные ордеров не найдены в Firebase');
            showNoDataMessage();
        }
        
    } catch (error) {
        console.error('Ошибка загрузки данных:', error);
        showErrorMessage('Ошибка загрузки данных из базы: ' + error.message);
    }
}

function displaySelectedOrderIds(data) {
    const container = document.getElementById('selected-orders-container');
    if (!container) {
        console.error('Контейнер не найден');
        return;
    }
    
    let html = '<div class="orders-list">';
    html += `<h3>Выбранные ордера (${data.count})</h3>`;
    html += `<p>Последнее обновление: ${new Date(data.timestamp).toLocaleString()}</p>`;
    html += '<div class="order-ids">';
    
    data.orderIds.forEach(orderId => {
        html += `
            <div class="order-item">
                <div class="order-info">
                    <span class="order-id">ID: ${orderId}</span>
                </div>
            </div>
        `;
    });
    
    html += '</div></div>';
    container.innerHTML = html;
}

function showNoDataMessage() {
    const container = document.getElementById('selected-orders-container');
    if (container) {
        container.innerHTML = `
            <div class="no-data">
                <h3>Нет выбранных ордеров</h3>
                <p>Выберите ордера в основном приложении, и они появятся здесь.</p>
            </div>
        `;
    }
}

function showErrorMessage(message) {
    const container = document.getElementById('selected-orders-container');
    if (container) {
        container.innerHTML = `
            <div class="error">
                <h3>Ошибка загрузки данных</h3>
                <p>${message}</p>
            </div>
        `;
    }
}

// Глобальные переменные
let selectedOrdersData = [];
let allOrdersData = [];
let currentCoinBalances = {};

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Firebase app загружается...');
    
    try {
        // Загружаем все ордера из базы данных
        await loadAllOrdersFromDatabase();
        
        // Загружаем выбранные ордера из Firebase
        await loadSelectedOrdersFromFirebase();
        
        // Загружаем балансы монет
        await updateCoinBalances();
        
        // Отображаем данные в нужном формате
        displaySelectedOrdersByCoin();
        
        // Обновляем данные каждые 30 секунд
        setInterval(async () => {
            await loadAllOrdersFromDatabase();
            await loadSelectedOrdersFromFirebase();
            await updateCoinBalances();
            displaySelectedOrdersByCoin();
        }, 30000);
        
    } catch (error) {
        console.error('❌ Ошибка при инициализации:', error);
        showError('Ошибка загрузки данных из Firebase');
    }
});

// Загрузка всех ордеров из базы данных
async function loadAllOrdersFromDatabase() {
    try {
        const { loadAllOrdersFromFirestore } = await import('./firestore-database.js');
        const result = await loadAllOrdersFromFirestore();
        
        if (result.success && result.orders && result.orders.length > 0) {
            allOrdersData = result.orders;
            console.log('✅ Загружено всех ордеров из Firestore:', result.orders.length);
        } else {
            console.log('ℹ️ Нет ордеров в Firestore');
            allOrdersData = [];
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки ордеров из Firestore:', error);
        allOrdersData = [];
    }
}

// Загрузка выбранных ордеров из Firebase
async function loadSelectedOrdersFromFirebase() {
    try {
        const { loadSelectedOrdersFromFirestore } = await import('./firestore-database.js');
        const result = await loadSelectedOrdersFromFirestore();
        
        if (result.success && result.orderIds && result.orderIds.length > 0) {
            // Фильтруем только выбранные ордера
            selectedOrdersData = allOrdersData.filter(order => 
                result.orderIds.includes(order.order_id)
            );
            console.log('✅ Загружено выбранных ордеров:', selectedOrdersData.length);
        } else {
            console.log('ℹ️ Нет выбранных ордеров в Firestore');
            selectedOrdersData = [];
        }
    } catch (error) {
        console.error('❌ Ошибка загрузки выбранных ордеров:', error);
        selectedOrdersData = [];
    }
}

// Отображение выбранных ордеров по монетам в нужном формате
function displaySelectedOrdersByCoin() {
    const container = document.getElementById('selected-orders-container');
    
    if (!container) {
        console.error('❌ Контейнер не найден');
        return;
    }
    
    if (selectedOrdersData.length === 0) {
        container.innerHTML = `
            <div class="no-data">
                <h3>Нет выбранных ордеров</h3>
                <p>Выберите ордера в основном приложении, и они появятся здесь.</p>
                <div class="available-orders">
                    <h4>Доступные ордера для выбора:</h4>
                    <div class="orders-list">
                        ${displayAvailableOrders()}
                    </div>
                </div>
            </div>
        `;
        return;
    }
    
    // Группируем ордера по монетам
    const ordersByCoin = {};
    selectedOrdersData.forEach(order => {
        const coin = order.product_id || 'UNKNOWN';
        if (!ordersByCoin[coin]) {
            ordersByCoin[coin] = [];
        }
        ordersByCoin[coin].push(order);
    });
    
    let html = '<div class="selected-orders-by-coin">';
    
    Object.keys(ordersByCoin).forEach(coin => {
        const orders = ordersByCoin[coin];
        const coinSymbol = coin.split('-')[0];
        const balance = currentCoinBalances[coinSymbol] || '0.00000000';
        
        html += `
            <div class="coin-section">
                <h2 class="coin-title">${coin}</h2>
                <div class="coin-balance">Balance: ${balance} ${coinSymbol}</div>
                
                <!-- Сводная таблица -->
                <table class="summary-table">
                    <thead>
                        <tr>
                            <th style="width: 30px;">Num</th>
                            <th>Best Bid</th>
                            <th>Best Ask</th>
                            <th>Copy Ask</th>
                            <th>Filled Size</th>
                            <th>-USD</th>
                            <th>Limit</th>
                            <th>Market</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        orders.forEach((order, index) => {
            const filledSize = parseFloat(order.filled_size || 0);
            const price = parseFloat(order.price || 0);
            const value = filledSize * price;
            const bestBid = price;
            const bestAsk = price * 1.005; // Примерный спред
            const profitLoss = calculateProfitLoss(order);
            
            html += `
                <tr>
                    <td>${index + 1}</td>
                    <td>$${bestBid.toFixed(4)}</td>
                    <td>$${bestAsk.toFixed(4)}</td>
                    <td><button class="copy-btn" onclick="copyAskPrice('${bestAsk.toFixed(4)}')">Copy</button></td>
                    <td>${filledSize.toFixed(2)}</td>
                    <td>${value.toFixed(2)}</td>
                    <td>-${(value * 0.05).toFixed(2)}</td>
                    <td>-${(value * 0.07).toFixed(2)} (${profitLoss})</td>
                </tr>
            `;
        });
        
        html += `
                    </tbody>
                </table>
                
                <!-- Детальная информация по ордерам -->
                <div class="detailed-orders">
        `;
        
        orders.forEach(order => {
            const filledSize = parseFloat(order.filled_size || 0);
            const price = parseFloat(order.price || 0);
            const value = filledSize * price;
            const fillPercentage = order.filled_size && order.size ? 
                ((parseFloat(order.filled_size) / parseFloat(order.size)) * 100).toFixed(0) : '0';
            const profitPercentage = calculateProfitPercentage(order);
            
            html += `
                <div class="order-detail" data-order-id="${order.order_id}">
                    <div class="order-summary">
                        <span class="order-id">${order.order_id.substring(0, 8)}... (${coin})</span>
                        <span class="order-side ${order.side}">${order.side}</span>
                        <span class="order-size">${filledSize.toFixed(2)}</span>
                        <span class="order-price">${price.toFixed(4)}</span>
                        <span class="order-filled">${filledSize.toFixed(2)}</span>
                        <span class="order-value">${value.toFixed(2)}</span>
                        <span class="order-status">${order.status}</span>
                        <span class="order-fill">${fillPercentage}%</span>
                        <button class="copy-btn" onclick="copyOrderToClipboard('${order.order_id}')">Copy</button>
                        <span class="profit-percentage ${profitPercentage >= 0 ? 'positive' : 'negative'}">${profitPercentage.toFixed(2)}%</span>
                    </div>
                    <div class="order-actions">
                        <button class="select-btn ${order.isSelected ? 'selected' : ''}" 
                                onclick="toggleOrderSelection('${order.order_id}')">
                            ${order.isSelected ? '✓ Выбран' : 'Выбрать'}
                        </button>
                    </div>
                </div>
            `;
        });
        
        html += `
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    container.innerHTML = html;
    
    console.log('✅ Отображено выбранных ордеров по монетам:', selectedOrdersData.length);
}

// Отображение доступных ордеров для выбора
function displayAvailableOrders() {
    if (allOrdersData.length === 0) {
        return '<p>Нет доступных ордеров в базе данных</p>';
    }
    
    let html = '';
    allOrdersData.slice(0, 10).forEach(order => { // Показываем первые 10 ордеров
        const filledSize = parseFloat(order.filled_size || 0);
        const price = parseFloat(order.price || 0);
        const value = filledSize * price;
        
        html += `
            <div class="available-order" data-order-id="${order.order_id}">
                <div class="order-info">
                    <span class="order-id">${order.order_id.substring(0, 8)}...</span>
                    <span class="product-id">${order.product_id}</span>
                    <span class="order-side ${order.side}">${order.side}</span>
                    <span class="order-price">$${price.toFixed(4)}</span>
                    <span class="order-value">$${value.toFixed(2)}</span>
                </div>
                <button class="select-order-btn" onclick="selectOrderFromDatabase('${order.order_id}')">
                    Выбрать этот ордер
                </button>
            </div>
        `;
    });
    
    return html;
}

// Функция для выбора ордера из базы данных
async function selectOrderFromDatabase(orderId) {
    try {
        
        console.log('Выбираем ордер:', orderId);
        
        // Добавляем ордер к выбранным
        const { saveSelectedOrdersToFirestore } = await import('./firestore-database.js');
        
        // Получаем текущие выбранные ордера
        const { loadSelectedOrdersFromFirestore } = await import('./firestore-database.js');
        const currentSelected = await loadSelectedOrdersFromFirestore();
        
        let orderIds = [];
        if (currentSelected.success && currentSelected.orderIds) {
            orderIds = [...currentSelected.orderIds];
        }
        
        // Добавляем новый ордер если его еще нет
        if (!orderIds.includes(orderId)) {
            orderIds.push(orderId);
            
            // Сохраняем обновленный список
            const result = await saveSelectedOrdersToFirestore(orderIds);
            
            if (result && result.success !== false) {
                console.log('✅ Ордер добавлен к выбранным');
                // Обновляем отображение
                await loadSelectedOrdersFromFirestore();
                displaySelectedOrdersByCoin();
                
                // Показываем уведомление
                showNotification('Ордер добавлен к выбранным!', 'success');
            } else {
                console.error('❌ Ошибка сохранения:', result.error);
                showNotification('Ошибка при добавлении ордера', 'error');
            }
        } else {
            showNotification('Ордер уже выбран', 'info');
        }
        
    } catch (error) {
        console.error('❌ Ошибка при выборе ордера:', error);
        showNotification('Ошибка при выборе ордера', 'error');
    }
}

// Переключение выбора ордера
async function toggleOrderSelection(orderId) {
    try {
        const { saveSelectedOrdersToFirestore, loadSelectedOrdersFromFirestore } = await import('./firestore-database.js');
        
        // Получаем текущие выбранные ордера
        const currentSelected = await loadSelectedOrdersFromFirestore();
        let orderIds = [];
        
        if (currentSelected.success && currentSelected.orderIds) {
            orderIds = [...currentSelected.orderIds];
        }
        
        // Переключаем выбор
        const index = orderIds.indexOf(orderId);
        if (index > -1) {
            // Убираем из выбранных
            orderIds.splice(index, 1);
            console.log('Убираем ордер из выбранных:', orderId);
        } else {
            // Добавляем к выбранным
            orderIds.push(orderId);
            console.log('Добавляем ордер к выбранным:', orderId);
        }
        
        // Сохраняем изменения
        const result = await saveSelectedOrdersToFirestore(orderIds);
        if (result.success) {
            console.log('✅ Выбранные ордера обновлены в Firestore');
        }
        
        // Обновляем отображение
        await loadSelectedOrdersFromFirestore();
        displaySelectedOrdersByCoin();
        
        showNotification(
            index > -1 ? 'Ордер убран из выбранных' : 'Ордер добавлен к выбранным', 
            'success'
        );
    } catch (error) {
        console.error('❌ Ошибка переключения выбора ордера:', error);
        showNotification('Ошибка при изменении выбора', 'error');
    }
}

// Вспомогательные функции
function calculateProfitLoss(order) {
    // Примерный расчет прибыли/убытка
    const filledSize = parseFloat(order.filled_size || 0);
    const price = parseFloat(order.price || 0);
    const value = filledSize * price;
    return (-value * 0.02).toFixed(2); // Примерный убыток 2%
}

function calculateProfitPercentage(order) {
    // Примерный расчет процента прибыли
    return Math.random() * 10 - 5; // Случайное значение от -5% до +5%
}

function copyAskPrice(price) {
    navigator.clipboard.writeText(price).then(() => {
        showNotification('Ask price скопирована в буфер обмена!', 'success');
    }).catch(err => {
        console.error('Ошибка копирования:', err);
    });
}

function copyOrderToClipboard(orderId) {
    const order = selectedOrdersData.find(o => o.order_id === orderId);
    if (order) {
        const orderData = JSON.stringify(order, null, 2);
        navigator.clipboard.writeText(orderData).then(() => {
            showNotification('Данные ордера скопированы!', 'success');
        }).catch(err => {
            console.error('Ошибка копирования:', err);
        });
    }
}

function showNotification(message, type = 'info') {
    const notification = document.getElementById('notification');
    if (notification) {
        notification.textContent = message;
        notification.className = `notification ${type}`;
        notification.style.display = 'block';
        
        setTimeout(() => {
            notification.style.display = 'none';
        }, 3000);
    }
}

function showError(message) {
    const container = document.getElementById('selected-orders-container');
    if (container) {
        container.innerHTML = `<div class="error">${message}</div>`;
    }
}

// Глобальные функции для совместимости
window.selectOrderFromDatabase = selectOrderFromDatabase;
window.toggleOrderSelection = toggleOrderSelection;
window.copyAskPrice = copyAskPrice;
window.copyOrderToClipboard = copyOrderToClipboard;

// Функция для загрузки балансов монет
async function updateCoinBalances() {
    try {
        // Получаем уникальные монеты из выбранных ордеров
        const uniqueCoins = [...new Set(selectedOrdersData.map(order => {
            const coin = order.product_id || 'UNKNOWN';
            return coin.split('-')[0]; // Получаем символ монеты (например, LOKA из LOKA-USD)
        }))];
        
        console.log('🪙 Загружаем балансы для монет:', uniqueCoins);
        
        // Загружаем баланс для каждой монеты
        for (const coin of uniqueCoins) {
            try {
                const response = await fetch(`/get-coin-balance/${coin}`);
                const balanceData = await response.json();
                
                if (balanceData.success) {
                    currentCoinBalances[coin] = balanceData.balance;
                    console.log(`💰 Баланс ${coin}: ${balanceData.balance}`);
                } else {
                    console.error(`❌ Ошибка загрузки баланса ${coin}:`, balanceData.error);
                    currentCoinBalances[coin] = '0.00000000';
                }
            } catch (error) {
                console.error(`❌ Ошибка запроса баланса ${coin}:`, error);
                currentCoinBalances[coin] = '0.00000000';
            }
        }
        
        console.log('✅ Все балансы загружены:', currentCoinBalances);
        
    } catch (error) {
        console.error('❌ Ошибка обновления балансов:', error);
    }
}