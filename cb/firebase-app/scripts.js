// import { saveSelectedOrdersToFirestore } from './firestore-database.js';

let currentOrders = new Map();
let ws;
const productInfoCache = new Map();

// Глобальная переменная для хранения созданных ордеров
let createdOrders = [];

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Page loaded, initializing...');

    try {
        // Load orders
        await loadLatestOrders();
        // Restore checkbox states after loading
        await loadSelectedOrdersFromServer();
        await updateSelectedOrders();
        console.log('Orders loaded');

        // Убираем автоматическую активацию первой строки при загрузке

        // Set default BTC for forms
        const buyInput = document.getElementById('coinInput');
        const sellInput = document.getElementById('sellCoinInput');
        const percentageInput = document.getElementById('percentageInput');

        if (buyInput) {
            buyInput.value = 'BTC';
            if (percentageInput) {
                percentageInput.value = '100';
                document.querySelectorAll('.percentage-button').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.value === '100');
                });
            }
            await updateBestBidForBuyForm();
            await updatePurchaseAmount();
        }

        if (sellInput) {
            sellInput.value = 'BTC';
            await updateBestAskPrice();
            await updateSellPurchaseAmount();
        }

        // Load USD balance
        await updateUSDBalance();



        // Setup event handlers
        setupProductClickHandlers();
        setupEventListeners();

        // Initialize WebSocket and price updates
        connectWebSocket();
        startPriceUpdates();

        // Periodic price updates
        setInterval(async () => {
            await updateBestBidForBuyForm();
            await updateBestAskPrice();
        }, 1000);

        // Update price changes every 30 seconds
        setInterval(() => {
            updatePriceChanges();
        }, 10000);

        // Handle checkbox states
        handleCheckboxStates();
    } catch (error) {
        console.error('Initialization error:', error);
    }
});

// Setup event listeners
function setupEventListeners() {
    // Coin input handlers
    const coinInput = document.getElementById('coinInput');
    if (coinInput) {
        coinInput.addEventListener('input', async function () {
            this.value = this.value.toUpperCase();
            try {
                await updateBestBidForBuyForm();
                await updatePurchaseAmount();
                await updateStopLimitPrices();
            } catch (error) {
                console.error('Error updating prices:', error);
            }
        }); // Добавлена закрывающая скобка здесь
    }

    document.getElementById('sellCoinInput')?.addEventListener('input', async function () {
        this.value = this.value.toUpperCase();
        try {
            await updateBestAskPrice();
            await updateSellPurchaseAmount();
        } catch (error) {
            console.error('Error updating price:', error);
        }
    });

    // Percentage buttons
    document.querySelectorAll('.percentage-button').forEach(button => {
        button.addEventListener('click', async () => {
            const value = button.dataset.value;
            const input = button.closest('tr').querySelector('input[type="number"]');
            const isSellForm = button.closest('.buy-form')?.querySelector('#sellCoinInput') !== null;

            let newValue;
            if (value.startsWith('+') || value.startsWith('-')) {
                newValue = Math.min(Math.max(parseInt(input.value) + parseInt(value), 10), 100);
            } else {
                newValue = value;
            }
            input.value = newValue;

            button.closest('td').querySelectorAll('.percentage-button').forEach(btn => btn.classList.remove('active'));
            if (!value.startsWith('+') && !value.startsWith('-')) button.classList.add('active');

            if (isSellForm) {
                await updateSellPurchaseAmount();
            } else {
                await updatePurchaseAmount();
                await updateStopLimitPrices();
            }
        });
    });

    // Percentage input
    document.getElementById('percentageInput')?.addEventListener('input', async () => {
        await updatePurchaseAmount();
        await updateStopLimitPrices();
    });
    document.getElementById('sellPercentageInput')?.addEventListener('input', updateSellPurchaseAmount);

    // Buy button
    document.getElementById('buyButton')?.addEventListener('click', async () => {
        const button = document.getElementById('buyButton');
        button.disabled = true;
        try {
            const coin = document.getElementById('coinInput').value.toUpperCase();
            const productInfo = await getProductInfo(coin);
            const bestBid = parseFloat(document.getElementById('bestBidPrice').textContent.replace('$', ''));

            if (isNaN(bestBid)) throw new Error('Invalid Best Bid price');

            const percentage = parseInt(document.getElementById('percentageInput').value);
            const balanceData = await (await fetch('/get-usd-account')).json();

            if (!balanceData.success || !balanceData.balance) throw new Error('Could not get USD balance');

            const availableUSD = parseFloat(balanceData.balance);
            const amountToSpend = (availableUSD * percentage) / 100;

            if (amountToSpend < 1) throw new Error('Order amount must be at least $1');
            if (amountToSpend > availableUSD) throw new Error('Insufficient funds');

            const fee = 0.006;
            const amountWithFee = amountToSpend / (1 + fee);
            const rawSize = amountWithFee / bestBid;
            const incrementDecimals = productInfo.base_increment.toString().split('.')[1]?.length || 0;
            const size = Number(rawSize.toFixed(incrementDecimals));

            const buyOrderData = { coin, baseSize: size.toString(), limitPrice: bestBid.toString() };
            const buyResult = await (await fetch('/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buyOrderData)
            })).json();

            if (buyResult.success) {
                // Save checkbox states before reloading
                await saveCheckboxStates();
                await loadLatestOrders();
                // Restore checkbox states after loading
                await loadSelectedOrdersFromServer();
                await updateSelectedOrders();
                await updateUSDBalance();
            } else {
                throw new Error(buyResult.error || 'Failed to create order');
            }
        } catch (error) {
            console.error('Error creating order:', error);
            alert(`Error creating order: ${error.message}`);
        } finally {
            button.disabled = false;
        }
    });

    // Sell button
    document.getElementById('sellButton')?.addEventListener('click', async () => {
        const button = document.getElementById('sellButton');
        button.disabled = true;
        try {
            const coin = document.getElementById('sellCoinInput').value.toUpperCase();
            const productInfo = await getProductInfo(coin);
            const bestAsk = parseFloat(document.getElementById('bestAskPrice').textContent.replace('$', ''));

            if (isNaN(bestAsk)) throw new Error('Invalid Best Ask price');

            const percentage = parseInt(document.getElementById('sellPercentageInput').value);
            const balanceData = await (await fetch(`/get-coin-balance/${coin}`)).json();

            if (!balanceData.success || !balanceData.balance) throw new Error('Could not get coin balance');

            const availableCoin = parseFloat(balanceData.balance);
            const amountToSell = (availableCoin * percentage) / 100;
            const valueInUSD = amountToSell * bestAsk;

            if (valueInUSD < 1) throw new Error('Order value must be at least $1');

            const baseIncrement = parseFloat(productInfo.base_increment);
            const size = Math.floor(amountToSell / baseIncrement) * baseIncrement;

            const sellOrderData = { coin, baseSize: size.toString(), limitPrice: bestAsk.toString(), side: 'SELL' };
            const sellResult = await (await fetch('/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sellOrderData)
            })).json();

            if (sellResult.success) {
                // Save checkbox states before reloading
                await saveCheckboxStates();
                await loadLatestOrders();
                // Restore checkbox states after loading
                await loadSelectedOrdersFromServer();
                await updateSelectedOrders();
                await updateUSDBalance();
            } else {
                throw new Error(sellResult.error || 'Failed to create sell order');
            }
        } catch (error) {
            console.error('Error creating sell order:', error);
            alert(`Error creating sell order: ${error.message}`);
        } finally {
            button.disabled = false;
        }
    });

    // Stop Limit button
    document.getElementById('buyStopLimitButton')?.addEventListener('click', async () => {
        const button = document.getElementById('buyStopLimitButton');
        button.disabled = true;
        try {
            const coin = document.getElementById('coinInput').value.toUpperCase();
            const productInfo = await getProductInfo(coin);
            const bestBid = parseFloat(document.getElementById('bestBidPrice').textContent.replace('$', ''));

            if (isNaN(bestBid)) throw new Error('Invalid Best Bid price');

            const stopPrice = bestBid * 1.002;
            const limitPrice = stopPrice * 1.002;
            const percentage = parseInt(document.getElementById('percentageInput').value);
            const balanceData = await (await fetch('/get-usd-account')).json();

            if (!balanceData.success || !balanceData.balance) throw new Error('Could not get USD balance');

            const availableUSD = parseFloat(balanceData.balance);
            const amountToSpend = (availableUSD * percentage) / 100;

            if (amountToSpend < 1) throw new Error('Order value must be at least $1');

            const fee = 0.006;
            const amountWithFee = amountToSpend / (1 + fee);
            const rawSize = amountWithFee / limitPrice;
            const incrementDecimals = productInfo.base_increment.toString().split('.')[1]?.length || 0;
            const size = Number(rawSize.toFixed(incrementDecimals));

            const stopLimitOrderData = {
                coin,
                baseSize: size.toString(),
                stopPrice: stopPrice.toString(),
                limitPrice: limitPrice.toString(),
                orderType: 'STOP_LIMIT'
            };

            const result = await (await fetch('/create-stop-limit-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(stopLimitOrderData)
            })).json();

            if (result.success) {
                // Save checkbox states before reloading
                await saveCheckboxStates();
                await loadLatestOrders();
                // Restore checkbox states after loading
                await loadSelectedOrdersFromServer();
                await updateSelectedOrders();
                await updateUSDBalance();
            } else {
                throw new Error(result.error || 'Failed to create stop limit order');
            }
        } catch (error) {
            console.error('Error creating stop limit order:', error);
            alert(`Error creating stop limit order: ${error.message}`);
        } finally {
            button.disabled = false;
        }
    });

    // Keyboard navigation
    document.addEventListener('keydown', e => {
        console.log('🎹 Клавиша нажата:', e.key, 'Фокус на:', e.target.tagName, e.target.id);
        
        // ВАЖНО: Обработка клавиши S ПЕРЕД проверкой полей ввода
        if (e.key === 's' || e.key === 'S') {
            console.log('🔥 Клавиша S нажата! Вызываем createOrderFromCurrentData...');
            console.log('🔍 Проверяем доступность функции:', typeof createOrderFromCurrentData);
            e.preventDefault();
            
            // Добавляем проверку существования функции
            if (typeof createOrderFromCurrentData === 'function') {
                console.log('✅ Функция найдена, вызываем...');
                createOrderFromCurrentData();
            } else {
                console.error('❌ Функция createOrderFromCurrentData не найдена!');
                alert('❌ Функция создания ордера не найдена!');
            }
            return; // Выходим, чтобы не выполнять остальные проверки
        }
        
        // Для остальных клавиш блокируем, если фокус на полях ввода
        if (e.target.matches('input, textarea')) {
            console.log('⚠️ Фокус на поле ввода, блокируем обработку клавиш (кроме S)');
            return;
        }

        if (e.code === 'Space') {
            e.preventDefault();
            const activeRow = document.querySelector('#ordersTableBody tr.active-row');
            if (activeRow) {
                const orderId = activeRow.id.replace('order-', '');
                const order = currentOrders.get(orderId);
                if (order) {
                    order.isSelected = !order.isSelected;
                    const selector = activeRow.querySelector('.order-selector');
                    if (selector) selector.classList.toggle('selected', order.isSelected);

                    if (order.isSelected) {
                        const coin = order.product_id.split('-')[0];
                        const buyInput = document.getElementById('coinInput');
                        const sellInput = document.getElementById('sellCoinInput');
                        if (buyInput) {
                            buyInput.value = coin;
                            buyInput.dispatchEvent(new Event('input'));
                        }
                        if (sellInput) {
                            sellInput.value = coin;
                            sellInput.dispatchEvent(new Event('input'));
                        }
                    }

                    saveCheckboxStates();
                    updateSelectedOrders().catch(error => console.error('Error updating selected orders:', error));
                }
            }
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            const activeRow = document.querySelector('#ordersTableBody tr.active-row');
            if (activeRow) {
                const orderId = activeRow.getAttribute('data-order-id');
                if (orderId) {
                    // Проверяем, есть ли уже уведомление для этого ордера
                    const alerts = JSON.parse(localStorage.getItem('priceAlerts') || '{}');
                    if (!alerts[orderId]) {
                        console.log('🔔 Создаем Telegram уведомление для ордера:', orderId);
                        sendTelegramMessage(orderId);
                    } else {
                        console.log('⚠️ Уведомление для ордера уже существует:', orderId);
                    }
                }
            }
        }

        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            
            const rows = Array.from(document.querySelectorAll('#ordersTableBody tr.order-row[data-order-id]'));
            if (!rows.length) return;

            const activeRow = document.querySelector('#ordersTableBody tr.active-row');
            let currentIndex = activeRow ? rows.indexOf(activeRow) : -1;

            if (e.key === 'ArrowUp') {
                currentIndex = currentIndex <= 0 ? rows.length - 1 : currentIndex - 1;
            } else {
                currentIndex = currentIndex >= rows.length - 1 ? 0 : currentIndex + 1;
            }

            const newRow = rows[currentIndex];
            if (newRow) {
                rows.forEach(row => row.classList.remove('active-row'));
                newRow.classList.add('active-row');
                newRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

                const orderId = newRow.getAttribute('data-order-id');
                if (orderId) {
                    const selectedOrderRow = document.querySelector(`.selected-orders-container tr[data-order-id="${orderId}"]`);
                    if (selectedOrderRow) {
                        document.querySelectorAll('.selected-orders-container tr.active-row').forEach(row => row.classList.remove('active-row'));
                        selectedOrderRow.classList.add('active-row');
                    }
                }
            }
        }
        
    }); // Added closing bracket for keydown

    // Selected orders click
    document.addEventListener('click', e => {
        const selectedOrderRow = e.target.closest('.selected-orders-container tr[data-order-id]');
        if (selectedOrderRow) {
            const orderId = selectedOrderRow.dataset.orderId;
            const latestOrderRow = document.getElementById(`order-${orderId}`);
            if (latestOrderRow) setActiveRow(latestOrderRow);
        }
    });



    // Copy event modification
    document.addEventListener('copy', e => {
        try {
            const selection = window.getSelection().toString();
            if (selection.includes('\tbuy\t') || selection.includes('\tBUY\t')) {
                const parts = selection.split('\t');
                const buyIndex = parts.findIndex(part => part.toLowerCase() === 'buy');
                if (buyIndex !== -1 && parts.length > 5 && !parts[5].startsWith('-')) {
                    parts[5] = '-' + parts[5];
                    e.preventDefault();
                    e.clipboardData.setData('text/plain', parts.join('\t'));
                    console.log('Modified clipboard data:', parts.join('\t'));
                }
            }
        } catch (error) {
            console.error('Error modifying clipboard data:', error);
        }
    });

    // Save checkbox states on unload
    window.addEventListener('beforeunload', saveCheckboxStates);
} // Added closing bracket for setupEventListeners}

// Price update functions
async function updateBestBidForBuyForm() {
    try {
        const coin = document.getElementById('coinInput').value.toUpperCase();
        if (!coin) return;

        const data = await (await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`)).json();
        const bestBidElement = document.getElementById('bestBidPrice');
        if (bestBidElement && data.bid) {
            bestBidElement.textContent = `$${parseFloat(data.bid).toFixed(8)}`;
            await updateStopLimitPrices();
        }
    } catch (error) {
        console.error('Error fetching best bid:', error);
        const bestBidElement = document.getElementById('bestBidPrice');
        if (bestBidElement) bestBidElement.textContent = 'Error loading price';
    }
}

async function updateBestAskPrice() {
    try {
        const coin = document.getElementById('sellCoinInput').value.toUpperCase();
        if (!coin) return;

        const data = await (await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`)).json();
        const bestAskElement = document.getElementById('bestAskPrice');
        if (bestAskElement && data.ask) bestAskElement.textContent = `$${parseFloat(data.ask).toFixed(8)}`;
    } catch (error) {
        console.error('Error fetching best ask:', error);
        const bestAskElement = document.getElementById('bestAskPrice');
        if (bestAskElement) bestAskElement.textContent = 'Error loading price';
    }
}

async function updateStopLimitPrices() {
    const bestBid = parseFloat(document.getElementById('bestBidPrice').textContent.replace('$', ''));
    if (!isNaN(bestBid)) {
        const stopPrice = bestBid * 1.002;
        const limitPrice = stopPrice * 1.002;
        document.getElementById('stopPrice').textContent = `$${stopPrice.toFixed(8)}`;
        document.getElementById('limitPrice').textContent = `$${limitPrice.toFixed(8)}`;
    }
}

// WebSocket connection
function connectWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}`);

    ws.onmessage = async event => {
        const data = JSON.parse(event.data);
        if (data.type === 'orders_update') {
            const hasChanges = data.orders.some(newOrder => {
                const existingOrder = currentOrders.get(newOrder.order_id);
                return !existingOrder ||
                    existingOrder.status !== newOrder.status ||
                    existingOrder.filled_size !== newOrder.filled_size ||
                    existingOrder.completion_percentage !== newOrder.completion_percentage;
            });

            if (hasChanges) {
        // Загружаем выбранные ордера из Firebase перед обновлением таблицы
        await loadSelectedOrdersFromServer();
        
        // Проверяем выбранные ордера ДО обновления таблицы
        const hasSelectedOrders = Array.from(currentOrders.values()).some(order => order.isSelected);
        
        await updateOrdersTable(data.orders, true);
        
        // Обновляем Selected Orders если есть выбранные ордера
        if (hasSelectedOrders) {
            await updateSelectedOrders();
        }
        
        await updateUSDBalance();
    }
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected, reconnecting...');
        setTimeout(connectWebSocket, 1000);
    };

    ws.onerror = error => console.error('WebSocket error:', error);
}

// Order management
async function loadLatestOrders() {
    try {
        const data = await (await fetch('/get-latest-orders')).json();
        if (data.success) {
            console.log('Loaded orders:', data.orders);
            await updateOrdersTable(data.orders, true);
            return data.orders;
        } else {
            console.error('Failed to load orders:', data.error);
            return [];
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        return [];
    }
}

async function updateOrdersTable(orders, checkForChanges = false) {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return console.error('Table body not found');

    const currentActiveOrderId = document.querySelector('.active-row')?.id?.replace('order-', '');
    const newOrders = new Map();
    
    // Сохраняем текущие состояния галочек ПЕРЕД обновлением
    const currentSelectionStates = new Map();
    currentOrders.forEach((order, orderId) => {
        if (order.isSelected) {
            currentSelectionStates.set(orderId, true);
        }
    });

    // Фильтруем дублирующиеся ордера по order_id
    const uniqueOrders = [];
    const seenOrderIds = new Set();
    
    orders.forEach(order => {
        if (!seenOrderIds.has(order.order_id)) {
            seenOrderIds.add(order.order_id);
            uniqueOrders.push(order);
        }
    });

    const sortedOrders = [...uniqueOrders].sort((a, b) => {
        const dateA = new Date(a.created_time.replace(/^-/, ''));
        const dateB = new Date(b.created_time.replace(/^-/, ''));
        return dateB.getTime() - dateA.getTime();
    });

    // Проверяем изменения только для критических полей, исключая поля которые часто меняются
    if (checkForChanges) {
        const existingRows = Array.from(tableBody.querySelectorAll('tr[data-order-id]'));
        const existingOrderIds = existingRows.map(row => row.getAttribute('data-order-id'));
        const newOrderIds = sortedOrders.map(order => order.order_id);
        
        // Проверяем только структурные изменения (новые/удаленные ордера)
        const hasStructuralChanges = existingOrderIds.length !== newOrderIds.length || 
            !existingOrderIds.every(id => newOrderIds.includes(id));
            
        if (!hasStructuralChanges) {
            // Обновляем только измененные ордера без полной перерисовки
            sortedOrders.forEach(order => {
                const existingOrder = currentOrders.get(order.order_id);
                
                // Восстанавливаем состояние галочки
                order.isSelected = currentSelectionStates.has(order.order_id) || 
                                 (existingOrder ? existingOrder.isSelected : false);
                
                // Проверяем изменения только в критических полях (исключаем filled_size, completion_percentage)
                const criticalFieldsChanged = !existingOrder || 
                    existingOrder.status !== order.status ||
                    existingOrder.product_id !== order.product_id ||
                    existingOrder.side !== order.side;
                
                if (criticalFieldsChanged) {
                    const row = document.getElementById(`order-${order.order_id}`);
                    if (row) {
                        row.classList.add('order-updated');
                        setTimeout(() => row.classList.remove('order-updated'), 1000);
                        
                        // Обновляем только измененные ячейки вместо полной перерисовки
                        const statusCell = row.querySelector('.status-cell');
                        if (statusCell) {
                            statusCell.textContent = order.status.toLowerCase();
                            statusCell.className = `status-${order.status.toLowerCase()}`;
                        }
                    }
                }
                
                newOrders.set(order.order_id, order);
            });
            
            currentOrders = newOrders;
            return; // Выходим без полной перерисовки
        }
    }

    tableBody.innerHTML = '';
    const headers = [
        '#', 'Order ID', 'Pair', 'Side', 'Type', 'Status', 'Created Date',
        'Size', 'Filled Size', 'Limit Price', 'Avg. Filled Price', 'Total Value (USD)',
        'Completion %', 'Fees', 'Action', 'Full Created Time'
    ];
    const headerRow = document.createElement('tr');
    headerRow.innerHTML = headers.map((header, index) => 
        `<th${index === headers.length - 1 ? ' style="display: none;"' : ''}>${header}</th>`
    ).join('');
    tableBody.appendChild(headerRow);

    sortedOrders.forEach(order => {
        const existingOrder = currentOrders.get(order.order_id);
        
        // ИСПРАВЛЕНО: Используем сохраненное состояние галочек
        order.isSelected = currentSelectionStates.has(order.order_id) || 
                          (existingOrder ? existingOrder.isSelected : false);
        
        newOrders.set(order.order_id, order);

        const isNewOrder = !existingOrder;
        const hasChanged = isNewOrder || JSON.stringify(existingOrder) !== JSON.stringify(order);
        const isOpenOrder = order.status === 'OPEN';

        const row = document.createElement('tr');
        row.id = `order-${order.order_id}`;
        row.setAttribute('data-order-id', order.order_id);
        row.classList.add('order-row');
        if (hasChanged) {
            row.classList.add('order-updated');
            setTimeout(() => row.classList.remove('order-updated'), 1000);
        }
        if (isOpenOrder) row.classList.add('open-order');

        const formattedDate = new Date(order.created_time).toLocaleDateString('en-US', {
            month: 'numeric', day: 'numeric', year: 'numeric'
        });
        
        // Полное время создания ордера в формате MM/DD/YYYY, HH:MM:SS AM/PM
        const fullCreatedTime = new Date(order.created_time).toLocaleString('en-US', {
            month: 'numeric',
            day: 'numeric', 
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });

        row.innerHTML = `
            <td class="selector-cell">
                <div class="order-selector ${order.isSelected ? 'selected' : ''}"
                     onclick="handleSelectorClick(this, '${order.order_id}')"
                     id="selector-${order.order_id}"></div>
            </td>
            <td>${order.order_id.split('-')[0]}-...</td>
            <td>${order.product_id}</td>
            <td class="${order.side.toLowerCase() === 'buy' ? 'text-green' : 'text-red'}">${order.side.toLowerCase()}</td>
            <td>${order.order_type}</td>
            <td class="status-${order.status.toLowerCase()}">${order.status.toLowerCase()}</td>
            <td>${formattedDate}</td>
            <td>${parseFloat(order.order_size).toFixed(1)}</td>
            <td>${parseFloat(order.filled_size).toFixed(8)}</td>
            <td>${parseFloat(order.limit_price).toFixed(8)}</td>
            <td>${parseFloat(order.average_filled_price).toFixed(8)}</td>
            <td>${parseFloat(order.total_value).toFixed(8)}</td>
            <td class="completion-cell ${parseFloat(order.completion_percentage) === 100 ? 'completion-filled' :
                (parseFloat(order.completion_percentage) > 0 && order.status === 'OPEN' ? 'completion-partial' : '')}" 
                style="--completion-width: ${order.completion_percentage}%">
                <span>${order.completion_percentage}%</span>
            </td>
            <td>$${parseFloat(order.total_fees).toFixed(2)}</td>
            <td>${order.status === 'OPEN' ? `<button data-order-id="${order.order_id}" 
                    class="cancel-order-btn bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded">Cancel</button>` : ''}</td>
            <td style="display: none;">${fullCreatedTime}</td>
        `;
        tableBody.appendChild(row);
    });

    currentOrders.forEach((_, orderId) => { if (!newOrders.has(orderId)) currentOrders.delete(orderId); });
    currentOrders = newOrders;

    // Убираем автоматическую активацию первой строки при обновлении таблицы

    // Убираем автоматическую активацию строк при отсутствии активной строки
}

async function cancelOrder(orderId) {
    const button = document.querySelector(`button[data-order-id="${orderId}"]`);
    if (button) {
        button.disabled = true;
        button.textContent = 'Cancelling...';
    }

    try {
        const response = await fetch(`/cancel-order/${orderId}`, { method: 'POST' });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `Server error: ${response.status}`);
        }

        if (data.success) {
            showCustomAlert('Order successfully cancelled', 'success');
            
            // Сохраняем состояние выбранных ордеров перед обновлением
            const selectedOrderIds = [];
            currentOrders.forEach(order => {
                if (order.isSelected && order.order_id !== orderId) {
                    selectedOrderIds.push(order.order_id);
                }
            });
            
            // Increase delay before updating data
            await new Promise(resolve => setTimeout(resolve, 3000));
            // Save checkbox states before reloading
            await saveCheckboxStates();
            await loadLatestOrders();
            // Restore checkbox states after loading
            await loadSelectedOrdersFromServer();
            await updateSelectedOrders();
            
            // Восстанавливаем состояние выбранных ордеров
            currentOrders.forEach(order => {
                if (selectedOrderIds.includes(order.order_id)) {
                    order.isSelected = true;
                    const selector = document.querySelector(`[data-order-id="${order.order_id}"] .order-selector`);
                    if (selector) {
                        selector.classList.add('selected');
                    }
                }
            });
            await updateUSDBalance();
        } else {
            throw new Error(data.error || 'Unknown error cancelling order');
        }
    } catch (error) {
        console.error('Error cancelling order:', error);
        showCustomAlert(`Error cancelling order: ${error.message}`);
        
        if (button) {
            button.disabled = false;
            button.textContent = 'Cancel';
        }
    }
}

// Add event handlers for cancel buttons
document.addEventListener('click', async (e) => {
    if (e.target.matches('.cancel-order-btn')) {
        const orderId = e.target.dataset.orderId;
        if (orderId) {
            await cancelOrder(orderId);
        }
    }
});

function setActiveRow(row) {
    if (!row) return;
    
    // Remove active-row class from all rows
    document.querySelectorAll('tr.active-row').forEach(r => r.classList.remove('active-row'));
    
    // Add active-row class to new active row
    row.classList.add('active-row');
    
    // Update corresponding row in selected orders
    const orderId = row.getAttribute('data-order-id');
    if (orderId) {
        const selectedOrderRow = document.querySelector(`.selected-orders-container tr[data-order-id="${orderId}"]`);
        if (selectedOrderRow) {
            document.querySelectorAll('.selected-orders-container tr.active-row')
                .forEach(r => r.classList.remove('active-row'));
            selectedOrderRow.classList.add('active-row');
        }
    }
}

// Checkbox state management
async function saveCheckboxStates() {
    const selectedIds = [];
    
    currentOrders.forEach(order => {
        // ✅ ИСПРАВЛЕНО: сохраняем все выбранные ордера независимо от статуса
        if (order.isSelected) {
            selectedIds.push(order.order_id);
        }
    });
    
    console.log('Сохраняем выбранные ордера:', selectedIds);
    
    // Сохраняем в Firebase
    try {
        const { saveSelectedOrdersToFirestore } = await import('./firestore-database.js');
        await saveSelectedOrdersToFirestore(selectedIds);
    } catch (error) {
        console.error('Error saving selected orders to Firestore:', error);
    }
}

function loadCheckboxStates() {
    // Убираем чтение из localStorage
    // try {
    //     return JSON.parse(localStorage.getItem('orderCheckboxStates') || '{}');
    // } catch {
    //     return {};
    // }
    
    // Возвращаем пустой объект, так как состояние будет загружаться через loadSelectedOrdersFromServer
    return {};
}

// Load selected orders from Firebase on startup
async function loadSelectedOrdersFromServer() {
    try {
        console.log('Loading selected orders from Firebase...');
        
        // Импортируем функцию из firestore-database.js
        const { loadSelectedOrdersFromFirestore } = await import('./firestore-database.js');
        const firestoreResult = await loadSelectedOrdersFromFirestore();
        
        if (firestoreResult.success && Array.isArray(firestoreResult.orderIds) && firestoreResult.orderIds.length > 0) {
            console.log('Loading selected orders from Firestore:', firestoreResult.orderIds);
            
            // Mark orders as selected in UI
            currentOrders.forEach(order => {
                if (firestoreResult.orderIds.includes(order.order_id)) {
                    order.isSelected = true;
                    
                    // Update visual state of checkbox
                    const selector = document.querySelector(`[data-order-id="${order.order_id}"] .order-selector`);
                    if (selector) {
                        selector.classList.add('selected');
                    }
                }
            });
            
            // Update selected orders table
            await updateSelectedOrders();
            
            console.log('Selected orders loaded from Firestore and UI updated');
        } else if (!firestoreResult.success) {
            console.warn('Failed to load from Firestore, falling back to server:', firestoreResult.error);
            
            // Fallback to server if Firebase fails
            const response = await fetch('/get-selected-orders-ids');
            if (response.ok) {
                const data = await response.json();
                console.log('Server fallback response:', data);
                
                if (data.success && Array.isArray(data.orderIds) && data.orderIds.length > 0) {
                    console.log('Loading selected orders from server fallback:', data.orderIds);
                    
                    // Mark orders as selected in UI
                    currentOrders.forEach(order => {
                        if (data.orderIds.includes(order.order_id)) {
                            order.isSelected = true;
                            
                            // Update visual state of checkbox
                            const selector = document.querySelector(`[data-order-id="${order.order_id}"] .order-selector`);
                            if (selector) {
                                selector.classList.add('selected');
                            }
                        }
                    });
                    
                    // Update selected orders table
                    await updateSelectedOrders();
                    
                    console.log('Selected orders loaded from server fallback and UI updated');
                }
            }
        } else {
            console.log('No selected orders found in Firestore');
        }
    } catch (error) {
        console.error('Error loading selected orders:', error);
        
        // Final fallback to server
        try {
            const response = await fetch('/get-selected-orders-ids');
            if (response.ok) {
                const data = await response.json();
                if (data.success && Array.isArray(data.orderIds) && data.orderIds.length > 0) {
                    currentOrders.forEach(order => {
                        if (data.orderIds.includes(order.order_id)) {
                            order.isSelected = true;
                            const selector = document.querySelector(`[data-order-id="${order.order_id}"] .order-selector`);
                            if (selector) {
                                selector.classList.add('selected');
                            }
                        }
                    });
                    await updateSelectedOrders();
                }
            }
        } catch (fallbackError) {
            console.error('Final fallback also failed:', fallbackError);
        }
    }
}

window.handleSelectorClick = (selector, orderId) => {
    const isSelected = selector.classList.toggle('selected');
    const order = currentOrders.get(orderId);
    if (order) {
        order.isSelected = isSelected;
        saveCheckboxStates();
        updateSelectedOrders().catch(error => console.error('Error updating selected orders:', error));
    }
};

// Selected orders table
async function updateSelectedOrders() {
    const container = document.getElementById('selectedOrdersContainer');
    if (!container) return console.error('selectedOrdersContainer not found');

    // Сначала собираем информацию о существующих таблицах
    const existingTables = new Map();
    container.querySelectorAll('.coin-orders-table').forEach(table => {
        const pair = table.querySelector('h4 a')?.textContent;
        if (pair) {
            existingTables.set(pair, table);
        }
    });

    const ordersByCoin = new Map();
    
    currentOrders.forEach(order => {
        if (order.isSelected) {
            const coin = order.product_id;
            if (!ordersByCoin.has(coin)) ordersByCoin.set(coin, []);
            ordersByCoin.get(coin).push(order);
        }
    });

    // Удаляем таблицы для монет, которые больше не выбраны
    existingTables.forEach((table, pair) => {
        if (!ordersByCoin.has(pair)) {
            table.remove();
            existingTables.delete(pair);
        }
    });

    if (!ordersByCoin.size) {
        container.innerHTML = '<div class="selected-order-row text-center text-gray-500 mt-4">No orders selected</div>';
        return;
    }

    const sortedPairs = Array.from(ordersByCoin.keys()).sort();
    for (const pair of sortedPairs) {
        const orders = ordersByCoin.get(pair).sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
        let tableContainer = existingTables.get(pair);
        const isNewTable = !tableContainer;

        if (isNewTable) {
            tableContainer = document.createElement('div');
            tableContainer.className = 'coin-orders-table mb-6 selected-order-row';
            tableContainer.classList.add('new-order');
        }

        let priceDecimals = 2;
        try {
            const coin = pair.split('-')[0];
            const productId = `${coin}-USD`;
            const tickerData = await (await fetch(`https://api.exchange.coinbase.com/products/${productId}/ticker`)).json();
            if (tickerData.ask) {
                const bestAsk = parseFloat(tickerData.ask);
                const decimalPart = bestAsk.toFixed(10).split('.')[1];
                priceDecimals = decimalPart ? decimalPart.replace(/0+$/, '').length : 0;
            } else if (productInfoCache.has(productId)) {
                const quoteIncrement = parseFloat(productInfoCache.get(productId).quote_increment);
                priceDecimals = Math.ceil(-Math.log10(quoteIncrement));
            } else {
                const productInfo = await (await fetch(`https://api.exchange.coinbase.com/products/${productId}`)).json();
                productInfoCache.set(productId, productInfo);
                const quoteIncrement = parseFloat(productInfo.quote_increment);
                priceDecimals = Math.ceil(-Math.log10(quoteIncrement));
            }
        } catch (error) {
            console.error(`Error fetching price info for ${pair}:`, error);
        }

        const totalFilledSize = orders.reduce((sum, order) => {
            const filledSize = parseFloat(order.filled_size) || 0;
            return sum + (order.side.toLowerCase() === 'buy' ? filledSize : -filledSize);
        }, 0);
        const formattedTotalFilledSize = Number(totalFilledSize.toFixed(8)).toString();
        const totalValue = orders.reduce((sum, order) => {
            const totalValue = parseFloat(order.total_value) || 0;
            return sum + (order.side.toLowerCase() === 'sell' ? -totalValue : totalValue);
        }, 0);
        const formattedTotalValue = totalValue.toFixed(2);


                        // <thead><tr><th>ID</th><th>Side</th><th>Size</th><th>Executed Price</th>
                //     <th>Filled Size</th><th>USD</th><th>Status</th><th>Comp</th><th>Copy</th><th>Chg %</th></tr></thead>
        tableContainer.innerHTML = `
            <div class="flex justify-between items-center mb-2">
                <h4 class="text-lg font-semibold">
                    <a href="https://www.coinbase.com/advanced-trade/spot/${pair}" 
                       target="_blank" class="hover:text-blue-500 transition-colors duration-200"
                       title="Open in Coinbase Advanced Trade">${pair}</a>
                </h4>
                <div class="coin-balance" data-pair="${pair}">Loading balance...</div>
            </div>
            <div class="summary-table mb-1">
                <table class="price-table w-full">
                    <thead><tr><th>Num</th><th>Best Bid</th><th>Best Ask</th><th>Copy Ask</th><th>Filled Size</th>
                        <th>USD</th><th>Limit</th><th>Market</th></tr></thead>
                    <tbody><tr><td>${orders.length}</td><td class="best-bid-cell" data-pair="${pair}">Loading...</td>
                        <td class="best-ask-cell" data-pair="${pair}">Loading...</td>
                        <td><button class="copy-ask-btn bg-green-500 hover:bg-green-600 text-white py-1 px-2 border-0" 
                            onclick="copyBestAsk('${pair}')">Copy</button></td>
                        <td class="${totalFilledSize === 0 ? 'total-filled-zero' : ''}">${formattedTotalFilledSize}</td>
                        <td>${formattedTotalValue}</td><td class="profit-cell" data-pair="${pair}">Calc...</td>
                        <td class="profit-market-cell" data-pair="${pair}">Calc...</td></tr></tbody>
                </table>
            </div>
            <table class="price-table w-full">
                <tbody>${orders.map(order => {
                    const executedPrice = parseFloat(order.average_filled_price) || 0;
                    const formattedExecutedPrice = executedPrice.toFixed(priceDecimals);
                    const size = parseFloat(order.order_size) || 0;
                    const formattedSize = Number(size.toFixed(8)).toString();
                    const filledSize = parseFloat(order.filled_size) || 0;
                    const formattedFilledSize = Number(filledSize.toFixed(8)).toString();
                    const totalValue = parseFloat(order.total_value) || 0;
                    const formattedTotalValue = totalValue.toFixed(2);

                    const copyData = [
                        order.order_id, order.product_id, order.side.toLowerCase(), formattedSize,
                        formattedExecutedPrice, formattedFilledSize, formattedTotalValue, order.status.toLowerCase()
                    ].join(';').replace(/'/g, "\\'");

                    return `
                        <tr data-order-id="${order.order_id}" class="selected-order-row ${!existingTables.has(pair) ? 'new-order' : ''} 
                            ${order.status === 'OPEN' ? 'selected-orders-open' : ''}">
                            <td>${order.order_id.split('-')[0]}-... <span class="text-gray-500 text-sm">(${order.product_id})</span></td>
                            <td class="${order.side.toLowerCase() === 'buy' ? 'text-green' : 'text-red'}">${order.side.toLowerCase()}</td>
                            <td>${formattedSize}</td><td>${formattedExecutedPrice}</td>
                            <td>${formattedFilledSize}</td><td>${formattedTotalValue}</td>
                            <td class="status-${order.status.toLowerCase()}">${order.status.toLowerCase()}</td>
                            <td><span class="completion-cell ${parseFloat(order.completion_percentage) === 100 ? 'completion-filled' :
                                (parseFloat(order.completion_percentage) > 0 && order.status === 'OPEN' ? 'completion-partial' : '')}" 
                                style="--completion-width: ${order.completion_percentage}%">
                                <span>${order.completion_percentage}%</span>
                            </span></td>
                            <td><button class="copy-btn" onclick="copyOrderToClipboard('${copyData}', this)">Copy</button></td>
                            <td style="display: none;">${new Date(order.created_time).toLocaleString('en-US', {
                                month: 'numeric',
                                day: 'numeric',
                                year: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: true
                            })}</td>
                            <td class="price-change-cell" data-pair="${pair}" data-executed-price="${executedPrice}" data-side="${order.side.toLowerCase()}">Loading...</td>
                        </tr>`;
                }).join('')}</tbody>
            </table>
        `;

        if (isNewTable) {
            container.appendChild(tableContainer);
            setTimeout(() => {
                tableContainer.classList.remove('new-order');
                tableContainer.querySelectorAll('.new-order').forEach(el => el.classList.remove('new-order'));
            }, 300);
        }

        try {
            const coin = pair.split('-')[0];
            const balanceData = await (await fetch(`/get-coin-balance/${coin}`)).json();
            const balanceElement = tableContainer.querySelector(`.coin-balance[data-pair="${pair}"]`);
            if (balanceElement) {
                balanceElement.innerHTML = balanceData.success
                    ? `Balance: ${parseFloat(balanceData.balance || 0).toFixed(8)} ${coin}`
                    : 'Error loading balance';
                balanceElement.classList.add(balanceData.success ? 'text-gray-600' : 'text-red-500');
            }
        } catch (error) {
            console.error(`Error loading balance for ${pair}:`, error);
            const balanceElement = tableContainer.querySelector(`.coin-balance[data-pair="${pair}"]`);
            if (balanceElement) {
                balanceElement.innerHTML = 'Error loading balance';
                balanceElement.classList.add('text-red-500');
            }
        }
        
        // Обновляем процентные изменения цен
        setTimeout(() => updatePriceChanges(), 1000);
        

    }
}

// Balance updates
async function updateUSDBalance() {
    try {
        const data = await (await fetch('/get-usd-account')).json();
        const balanceElement = document.getElementById('usdBalance');
        if (!balanceElement) return;

        if (data.success) {
            const availableBalance = parseFloat(data.balance || 0);
            const holdAmount = parseFloat(data.hold || 0);
            balanceElement.innerHTML = `
                <div class="flex items-center space-x-4">
                    <span class="font-bold">USD Balance: $${availableBalance.toFixed(2)}</span>
                </div>`;
        } else {
            balanceElement.innerHTML = '<div class="text-red-500">Error loading USD balance</div>';
        }
    } catch (error) {
        console.error('Error updating USD balance:', error);
        const balanceElement = document.getElementById('usdBalance');
        if (balanceElement) balanceElement.innerHTML = `<div class="text-red-500">Error: ${error.message}</div>`;
    }
}

// Price and profit calculations
async function getBestPrices(pair) {
    try {
        const data = await (await fetch(`https://api.exchange.coinbase.com/products/${pair}/ticker`)).json();
        return data && data.bid && data.ask ? { bid: data.bid, ask: data.ask } : null;
    } catch (error) {
        console.error(`Error getting prices for ${pair}:`, error);
        return null;
    }
}

async function calculateMarketProfit(pair, totalFilledSize, totalValue) {
    try {
        console.log(`Calculating Market Profit for ${pair}, Size: ${totalFilledSize}, Total Value: ${totalValue}`);
        
        const response = await fetch(`https://api.exchange.coinbase.com/products/${pair}/book?level=2`);
        if (!response.ok) {
            console.error(`Failed to fetch order book for ${pair}: ${response.status}`);
            return null;
        }
        
        const data = await response.json();
        if (!data.bids || data.bids.length === 0) {
            console.error(`No bids available for ${pair}`);
            return null;
        }

        const arrBids = [];
        for (let i = 0; i < Math.min(data.bids.length, 100); i++) {
            const size = parseFloat(data.bids[i][1]);
            const price = parseFloat(data.bids[i][0]);
            if (!isNaN(size) && !isNaN(price)) {
                arrBids.push([size, price]);
            }
        }
        
        console.log(`Fetched ${arrBids.length} bids for ${pair}`);

        let totalAmount = 0;
        let remainingSize = totalFilledSize;

        for (let i = 0; i < arrBids.length; i++) {
            const [size, price] = arrBids[i];
            
            if (remainingSize <= size) {
                totalAmount += remainingSize * price;
                remainingSize = 0;
                console.log(`Filled ${totalFilledSize} at price ${price}`);
                break;
            } else {
                totalAmount += size * price;
                remainingSize -= size;
                console.log(`Filled ${size} at price ${price}, remaining: ${remainingSize}`);
            }
        }

        if (remainingSize > 0) {
            const lastPrice = arrBids[arrBids.length - 1][1];
            console.warn(`Insufficient bid volume for ${pair}, using last bid price ${lastPrice} for remaining ${remainingSize}`);
            totalAmount += remainingSize * lastPrice;
        }

        const afterFees = totalAmount * (1 - window.FEES.PROFIT_MARKET);
        const profit = afterFees - totalValue;

        console.log(`Market Profit for ${pair}: ${profit.toFixed(2)} (Total Amount: ${totalAmount}, After Fees: ${afterFees})`);
        
        return profit.toFixed(2);
    } catch (error) {
        console.error(`Error calculating Market Profit for ${pair}:`, error);
        return null;
    }
}

async function updatePrices(pair) {
    try {
        const response = await fetch(`https://api.exchange.coinbase.com/products/${pair}/ticker`);
        if (!response.ok) throw new Error('Network response was not ok');
        
        const data = await response.json();
        if (!data || !data.bid || !data.ask) throw new Error('Invalid price data');

        const bidCells = document.querySelectorAll(`.best-bid-cell[data-pair="${pair}"]`);
        const askCells = document.querySelectorAll(`.best-ask-cell[data-pair="${pair}"]`);
        const profitCells = document.querySelectorAll(`.profit-cell[data-pair="${pair}"]`);
        const profitMarketCells = document.querySelectorAll(`.profit-market-cell[data-pair="${pair}"]`);

        const bidPrice = parseFloat(data.bid);
        const askPrice = parseFloat(data.ask);

        if (isNaN(bidPrice) || isNaN(askPrice)) throw new Error('Invalid price format');

        // Проверяем, есть ли созданные ордера для этой пары
        const createdOrdersForPair = createdOrders.filter(order => order.pair === pair);
        
        bidCells.forEach(cell => {
            cell.textContent = `$${data.bid}`;
            cell.classList.remove('error', 'created-order-highlight');
            
            // Подсвечиваем, если цена близка к созданному ордеру
            createdOrdersForPair.forEach(order => {
                const orderPrice = parseFloat(order.executedPrice);
                const priceDiff = Math.abs(bidPrice - orderPrice) / orderPrice;
                if (priceDiff < 0.001) { // Если разница меньше 0.1%
                    cell.classList.add('created-order-highlight');
                    cell.style.backgroundColor = '#fef3c7'; // Желтый фон
                    cell.style.border = '2px solid #f59e0b'; // Желтая рамка
                }
            });
        });

        askCells.forEach(cell => {
            cell.textContent = `$${data.ask}`;
            cell.classList.remove('error', 'created-order-highlight');
            
            // Подсвечиваем, если цена близка к созданному ордеру
            createdOrdersForPair.forEach(order => {
                const orderPrice = parseFloat(order.executedPrice);
                const priceDiff = Math.abs(askPrice - orderPrice) / orderPrice;
                if (priceDiff < 0.001) { // Если разница меньше 0.1%
                    cell.classList.add('created-order-highlight');
                    cell.style.backgroundColor = '#fef3c7'; // Желтый фон
                    cell.style.border = '2px solid #f59e0b'; // Желтая рамка
                }
            });
        });

        profitCells.forEach(cell => {
            const row = cell.closest('tr');
            const totalFilledSize = parseFloat(row.querySelector('td:nth-child(5)').textContent);
            const totalValue = parseFloat(row.querySelector('td:nth-child(6)').textContent);
            
            if (!isNaN(totalFilledSize) && !isNaN(totalValue) && !isNaN(askPrice)) {
                const potentialValue = askPrice * totalFilledSize;
                const afterFees = potentialValue * (1 - window.FEES.PROFIT_LIMIT);
                const profit = afterFees - totalValue;
                
                const profitFormatted = profit.toFixed(2);
                cell.textContent = profitFormatted;

                console.log(`Profit Limit for ${pair}: ${profitFormatted} (Ask=${askPrice}, Size=${totalFilledSize}, Value=${totalValue})`);
                
                cell.classList.remove('positive', 'negative', 'error');
                if (profit > 0) {
                    cell.classList.add('positive');
                } else if (profit < 0) {
                    cell.classList.add('negative');
                }
            } else {
                console.error(`Invalid data for Profit Limit: ${pair}, Size=${totalFilledSize}, Value=${totalValue}, Ask=${askPrice}`);
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });

        profitMarketCells.forEach(async cell => {
            const row = cell.closest('tr');
            const totalFilledSize = parseFloat(row.querySelector('td:nth-child(5)').textContent);
            const totalValue = parseFloat(row.querySelector('td:nth-child(6)').textContent);
            const limitProfitCell = row.querySelector('.profit-cell');
            const limitProfit = parseFloat(limitProfitCell?.textContent || 0);

            if (!isNaN(totalFilledSize) && !isNaN(totalValue)) {
                const marketProfit = await calculateMarketProfit(pair, totalFilledSize, totalValue);

                if (marketProfit !== null) {
                    const difference = (parseFloat(marketProfit) - limitProfit).toFixed(2);
                    const differenceHtml = `
                        <span class="profit-difference ${difference < 0 ? 'negative' : 'positive'}">
                            (${difference})
                        </span>
                    `;
                    
                    cell.innerHTML = `${marketProfit}${differenceHtml}`;
                    
                    console.log(`Profit Market for ${pair}: ${marketProfit}, Difference: ${difference}`);
                    
                    cell.classList.remove('error', 'positive', 'negative');
                    if (parseFloat(marketProfit) > 0) {
                        cell.classList.add('positive');
                    } else if (parseFloat(marketProfit) < 0) {
                        cell.classList.add('negative');
                    }
                } else {
                    console.error(`Failed to calculate Market Profit for ${pair}`);
                    cell.textContent = 'Error';
                    cell.classList.add('error');
                }
            } else {
                console.error(`Invalid data for Profit Market: ${pair}, Size=${totalFilledSize}, Value=${totalValue}`);
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });
    } catch (error) {
        console.error(`Error updating prices for ${pair}:`, error);
        const cells = [
            ...document.querySelectorAll(`.best-bid-cell[data-pair="${pair}"]`),
            ...document.querySelectorAll(`.best-ask-cell[data-pair="${pair}"]`),
            ...document.querySelectorAll(`.profit-cell[data-pair="${pair}"]`),
            ...document.querySelectorAll(`.profit-market-cell[data-pair="${pair}"]`)
        ];
        
        cells.forEach(cell => {
            if (!cell.textContent || cell.textContent === 'Loading...') {
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });
    }
}

function startPriceUpdates() {
    setInterval(() => {
        const pairs = new Set();
        document.querySelectorAll('.best-bid-cell').forEach(cell => pairs.add(cell.dataset.pair));
        pairs.forEach(updatePrices);
    }, 1000);
}

// Purchase amount calculations
async function updatePurchaseAmount() {
    try {
        const balanceData = await (await fetch('/get-usd-account')).json();
        if (balanceData.success) {
            const availableUSD = parseFloat(balanceData.balance);
            const percentage = parseInt(document.getElementById('percentageInput').value);
            const fee = 0.003;
            const rawAmount = (availableUSD * percentage) / 100;
            const amountWithFee = rawAmount / (1 + fee);
            const purchaseAmountElement = document.getElementById('purchaseAmount');
            if (purchaseAmountElement) purchaseAmountElement.textContent = `$${amountWithFee.toFixed(2)}`;
            await updateOrderSize(amountWithFee);
        }
    } catch (error) {
        console.error('Error updating purchase amount:', error);
        const purchaseAmountElement = document.getElementById('purchaseAmount');
        if (purchaseAmountElement) purchaseAmountElement.textContent = 'Error';
    }
}

async function updateSellPurchaseAmount() {
    try {
        const coin = document.getElementById('sellCoinInput').value.toUpperCase();
        const balanceData = await (await fetch(`/get-coin-balance/${coin}`)).json();
        if (balanceData.success) {
            const availableCoin = parseFloat(balanceData.balance || 0);
            const percentage = parseInt(document.getElementById('sellPercentageInput').value);
            const productInfo = await getProductInfo(coin);
            const baseIncrement = parseFloat(productInfo.base_increment);
            const incrementDecimals = baseIncrement.toString().split('.')[1]?.length || 0;
            const amountToSell = (availableCoin * percentage) / 100;
            const roundedAmount = Math.floor(amountToSell / baseIncrement) * baseIncrement;
            const sellPurchaseAmountElement = document.getElementById('sellPurchaseAmount');
            if (sellPurchaseAmountElement) sellPurchaseAmountElement.textContent = roundedAmount.toFixed(incrementDecimals);
        }
    } catch (error) {
        console.error('Error updating sell amount:', error);
        const sellPurchaseAmountElement = document.getElementById('sellPurchaseAmount');
        if (sellPurchaseAmountElement) sellPurchaseAmountElement.textContent = 'Error';
    }
}

async function updateOrderSize(amount) {
    try {
        const bestBid = parseFloat(document.getElementById('bestBidPrice').textContent.replace('$', ''));
        if (!isNaN(bestBid) && bestBid > 0) return amount / bestBid;
    } catch (error) {
        console.error('Error updating order size:', error);
    }
    return 0;
}

// Product info
async function getProductInfo(coin) {
    try {
        console.log(`🔍 getProductInfo: Начинаем получение информации для ${coin}`);
        const productId = `${coin}-USD`;
        
        if (productInfoCache.has(productId)) {
            console.log(`✅ getProductInfo: Информация для ${productId} найдена в кеше`);
            return productInfoCache.get(productId);
        }

        console.log(`🌐 getProductInfo: Отправляем запрос к API для ${productId}`);
        const response = await fetch(`https://api.exchange.coinbase.com/products/${productId}`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log(`📊 getProductInfo: Получен ответ от API:`, data);
        
        if (data.error) {
            throw new Error(`Product ${productId} not found: ${data.error}`);
        }

        const productInfo = { 
            id: productId, 
            base_increment: data.base_increment, 
            quote_increment: data.quote_increment,
            base_min_size: data.base_min_size
        };
        
        console.log(`✅ getProductInfo: Информация о продукте обработана:`, productInfo);
        productInfoCache.set(productId, productInfo);
        return productInfo;
    } catch (error) {
        console.error(`❌ getProductInfo: Ошибка при получении информации о ${coin}:`, error);
        throw error;
    }
}

// Product click handlers
function setupProductClickHandlers() {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return;

    tableBody.addEventListener('click', async e => {
        const productCell = e.target.closest('td:nth-child(3)');
        if (!productCell) return;

        try {
            const coin = productCell.textContent.trim().split('-')[0];
            const buyInput = document.getElementById('coinInput');
            const sellInput = document.getElementById('sellCoinInput');
            if (buyInput) {
                buyInput.value = coin;
                buyInput.dispatchEvent(new Event('input'));
            }
            if (sellInput) {
                sellInput.value = coin;
                sellInput.dispatchEvent(new Event('input'));
            }
        } catch (error) {
            console.error('Error setting coin from product:', error);
        }
    });
}

// Clipboard functions
function copyToClipboard(text, message) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showCustomAlert(message);
    } catch (error) {
        console.error('Error copying to clipboard:', error);
        showCustomAlert('Error copying to clipboard: ' + error.message, true);
    }
}

window.copyOrderToClipboard = (copyData, buttonElement) => {
    console.log('🔍 copyOrderToClipboard вызвана с:', copyData, buttonElement);
    
    // Если buttonElement не передан, пытаемся найти через event
    const button = buttonElement || (typeof event !== 'undefined' ? event.target : null);
    console.log('🔘 Найденная кнопка:', button);
    
    if (button) {
        const row = button.closest('tr');
        console.log('📋 Найденная строка:', row);
        
        if (row) {
            const cells = row.querySelectorAll('td');
            console.log('📊 Количество ячеек:', cells.length);
            console.log('📊 Содержимое ячеек:', Array.from(cells).map((cell, index) => `${index}: ${cell.textContent.trim()}`));
            
            if (cells.length >= 10) { // В selected orders таблице 11 ячеек
                // Извлекаем Order ID и Pair из copyData
                const orderParts = copyData.replace(/\'/g, "'").split(';');
                const orderId = orderParts[0];
                const productId = orderParts[1];
                const shortOrderId = orderId.split('-')[0] + '-...';
                const orderIdWithPair = `${shortOrderId} (${productId})`;
                
                // Копируем данные из правильных ячеек selected orders таблицы:
                const sideText = cells[1].textContent.replace(/\s+/g, ' ').trim(); // Side из второй колонки
                const thirdColumnText = cells[2].textContent.replace(/\s+/g, ' ').trim(); // Size из третьей колонки
                const priceText = cells[3].textContent.replace(/\s+/g, ' ').trim(); // Price из четвертой колонки
                const filledSizeText = cells[4].textContent.replace(/\s+/g, ' ').trim(); // Filled Size из пятой колонки
                let valueText = cells[5].textContent.replace(/\s+/g, ' ').trim(); // Value из шестой колонки
                const statusText = cells[6].textContent.replace(/\s+/g, ' ').trim(); // Status из седьмой колонки
                const percentText = cells[7].textContent.replace(/\s+/g, ' ').trim(); // Percent из восьмой колонки
                const createdTimeText = cells[9].textContent.replace(/\s+/g, ' ').trim(); // Скрытая колонка с временем
                
                // Форматируем время в нужный формат MM/DD/YYYY, HH:MM:SS AM/PM
                let formattedTime = createdTimeText;
                try {
                    const date = new Date(createdTimeText);
                    if (!isNaN(date.getTime())) {
                        formattedTime = date.toLocaleString('en-US', {
                            month: 'numeric',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: true
                        });
                    }
                } catch (e) {
                    console.log('Ошибка форматирования времени:', e);
                }
                
                // Добавляем знак "-" к значению если сторона равна "buy"
                if (sideText.toLowerCase() === 'buy') {
                    // Убираем существующий знак "-" если есть, затем добавляем
                    valueText = valueText.replace(/^-/, '');
                    valueText = '-' + valueText;
                }
                
                console.log('✅ Извлеченные данные:', {
                    orderIdWithPair,
                    sideText,
                    thirdColumnText,
                    priceText,
                    filledSizeText,
                    valueText,
                    statusText,
                    percentText,
                    formattedTime
                });
                
                // Формируем строку: Order ID (Pair) + данные из ячеек + время создания
                const textToCopy = `${orderIdWithPair}\t${sideText}\t${thirdColumnText}\t${priceText}\t${filledSizeText}\t${valueText}\t${statusText}\t${percentText}\t${formattedTime}`;
                console.log('📋 Текст для копирования:', JSON.stringify(textToCopy));
                
                copyToClipboard(textToCopy, 'Order data copied to clipboard!');
                return;
            } else {
                console.log('❌ Недостаточно ячеек в строке:', cells.length);
            }
        } else {
            console.log('❌ Строка не найдена');
        }
    } else {
        console.log('❌ Кнопка не найдена, используем fallback');
    }
    
    // Fallback к старому методу
    console.log('⚠️ Выполняется fallback код');
    const orderParts = copyData.replace(/\'/g, "'").split(';');
    const orderId = orderParts[0];
    const productId = orderParts[1];
    const shortOrderId = orderId.split('-')[0] + '-...';
    const textToCopy = `${shortOrderId} (${productId})`;
    console.log('📋 Fallback текст:', textToCopy);
    copyToClipboard(textToCopy, 'Order ID and pair copied to clipboard!');
};

// Custom alert
function showCustomAlert(message, isError = false) {
    const alertDiv = document.createElement('div');
    alertDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 10px 20px;
        background-color: ${isError ? '#ef4444' : '#22c55e'};
        color: white;
        border-radius: 4px;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: space-between;
        animation: slideIn 0.3s ease-out;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    `;

    alertDiv.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()" style="
            background: transparent;
            border: none;
            color: white;
            margin-left: 15px;
            cursor: pointer;
            font-size: 18px;
            padding: 0;
            line-height: 1;
        ">&times;</button>
    `;

    document.body.appendChild(alertDiv);

    // Add animation style
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    // Auto-hide after 5 seconds
    setTimeout(() => {
        if (alertDiv.parentElement) {
            alertDiv.style.animation = 'slideOut 0.3s ease-in';
            setTimeout(() => alertDiv.remove(), 300);
        }
    }, 5000);
}

window.showCustomAlert = showCustomAlert;

// Copy Best Ask function
async function copyBestAsk(pair) {
    try {
        const askCell = document.querySelector(`.best-ask-cell[data-pair="${pair}"]`);
        if (!askCell) {
            console.error('Ask cell not found');
            return;
        }
        const askPrice = askCell.textContent;
        console.log('Copying price:', askPrice);
        if (askPrice && askPrice !== 'Loading...') {
            const numericPrice = askPrice.replace(/[^0-9.]/g, '');
            console.log('Numeric price:', numericPrice);
            await navigator.clipboard.writeText(numericPrice);
            showCustomAlert('Price copied!');
        }
    } catch (error) {
        console.error('Error copying price:', error);
        showCustomAlert('Failed to copy price', 'error');
    }
}

// Make copyBestAsk available globally
window.copyBestAsk = copyBestAsk;

// Make createOrderFromCurrentData available globally
window.createOrderFromCurrentData = createOrderFromCurrentData;

// Добавляем отладочную информацию после определения функции
console.log('✅ Функция createOrderFromCurrentData определена:', typeof createOrderFromCurrentData);

// Также добавьте глобальную привязку для отладки:
window.createOrderFromCurrentData = createOrderFromCurrentData;
console.log('🌐 Функция добавлена в window:', typeof window.createOrderFromCurrentData);

// Checkbox state handling
function handleCheckboxStates() {
    try {
        const savedStates = localStorage.getItem('checkboxStates');
        if (savedStates) {
            const states = JSON.parse(savedStates);
            document.querySelectorAll('input[type="checkbox"][data-id]').forEach(checkbox => {
                const id = checkbox.getAttribute('data-id');
                if (states.hasOwnProperty(id)) checkbox.checked = states[id];
            });
        }
    } catch (error) {
        console.error('Error loading checkbox states:', error);
    }

    document.querySelectorAll('input[type="checkbox"][data-id]').forEach(checkbox => {
        checkbox.addEventListener('change', function () {
            try {
                const id = this.getAttribute('data-id');
                if (!id) return;

                const states = JSON.parse(localStorage.getItem('checkboxStates') || '{}');
                states[id] = this.checked;
                localStorage.setItem('checkboxStates', JSON.stringify(states));
            } catch (error) {
                console.error('Error saving checkbox state:', error);
            }
        });
    });
}

// Функция для обновления процентного изменения цены
async function updatePriceChanges() {
    const priceChangeCells = document.querySelectorAll('.price-change-cell');
    const pairs = new Set();
    
    // Собираем уникальные пары
    priceChangeCells.forEach(cell => {
        const pair = cell.getAttribute('data-pair');
        if (pair) pairs.add(pair);
    });
    
    // Обновляем цены для каждой пары
    for (const pair of pairs) {
        try {
            const prices = await getBestPrices(pair);
            if (!prices) continue;
            
            const currentPrice = parseFloat(prices.ask); // Используем ask цену для покупок
            
            // Обновляем все ячейки для этой пары
            const cellsForPair = document.querySelectorAll(`.price-change-cell[data-pair="${pair}"]`);
            cellsForPair.forEach(cell => {
                const executedPrice = parseFloat(cell.getAttribute('data-executed-price'));
                const side = cell.getAttribute('data-side');
                
                if (executedPrice && currentPrice) {
                    let priceChange;
                    if (side === 'buy') {
                        // Для покупок: (текущая цена - цена исполнения) / цена исполнения * 100
                        priceChange = ((currentPrice - executedPrice) / executedPrice) * 100;
                    } else {
                        // Для продаж: (цена исполнения - текущая цена) / цена исполнения * 100
                        priceChange = ((executedPrice - currentPrice) / executedPrice) * 100;
                    }
                    
                    const formattedChange = priceChange.toFixed(2);
                    const colorClass = priceChange >= 0 ? 'text-green-600' : 'text-red-600';
                    const sign = priceChange >= 0 ? '+' : '';
                    
                    cell.innerHTML = `<span class="${colorClass}">${sign}${formattedChange}%</span>`;
                } else {
                    cell.innerHTML = '<span class="text-gray-500">N/A</span>';
                }
            });
        } catch (error) {
            console.error(`Error updating price changes for ${pair}:`, error);
            const cellsForPair = document.querySelectorAll(`.price-change-cell[data-pair="${pair}"]`);
            cellsForPair.forEach(cell => {
                cell.innerHTML = '<span class="text-red-500">Error</span>';
            });
        }
    }
}

// Функция для создания ордера по нажатию S (с улучшенной обработкой ошибок)
async function createOrderFromCurrentData() {
    // Добавляем логирование в самое начало функции
    console.log('🔥 ФУНКЦИЯ createOrderFromCurrentData ВЫЗВАНА! Клавиша S нажата!');
    
    try {
        console.log('🚀 Начинаем создание ордера...');
        
        // Получаем монету из поля ввода
        const coinInput = document.getElementById('coinInput');
        if (!coinInput || !coinInput.value) {
            throw new Error('❌ Монета не указана в поле coinInput');
        }
        
        const coin = coinInput.value.toUpperCase();
        console.log('💰 Монета:', coin);
        
        // Получаем информацию о продукте
        console.log('📊 Получаем информацию о продукте...');
        const productInfo = await getProductInfo(coin);
        if (!productInfo) {
            throw new Error(`❌ Не удалось получить информацию о продукте ${coin}`);
        }
        console.log('✅ Информация о продукте получена:', productInfo);
        
        // Получаем цену
        const bestBidElement = document.getElementById('bestBidPrice');
        if (!bestBidElement || !bestBidElement.textContent) {
            throw new Error('❌ Элемент bestBidPrice не найден или пуст');
        }
        
        const bestBid = parseFloat(bestBidElement.textContent.replace('$', ''));
        if (isNaN(bestBid) || bestBid <= 0) {
            throw new Error(`❌ Некорректная цена Best Bid: ${bestBidElement.textContent}`);
        }
        console.log('💲 Best Bid цена:', bestBid);

        // Получаем процент из поля ввода
        const percentageElement = document.getElementById('percentageInput');
        if (!percentageElement || !percentageElement.value) {
            throw new Error('❌ Поле percentageInput не найдено или пусто');
        }
        
        const percentage = parseInt(percentageElement.value);
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
            throw new Error(`❌ Некорректный процент: ${percentageElement.value}`);
        }
        console.log('📊 Процент для покупки:', percentage + '%');
        
        // Получаем баланс USD
        console.log('💳 Получаем баланс USD...');
        const balanceResponse = await fetch('/get-usd-account');
        if (!balanceResponse.ok) {
            throw new Error(`❌ Ошибка запроса баланса: ${balanceResponse.status} ${balanceResponse.statusText}`);
        }
        
        const balanceData = await balanceResponse.json();
        console.log('💰 Ответ сервера по балансу:', balanceData);

        if (!balanceData.success) {
            throw new Error(`❌ Сервер вернул ошибку баланса: ${balanceData.error || 'Неизвестная ошибка'}`);
        }
        
        if (!balanceData.balance) {
            throw new Error('❌ Баланс USD не найден в ответе сервера');
        }

        const availableUSD = parseFloat(balanceData.balance);
        if (isNaN(availableUSD) || availableUSD <= 0) {
            throw new Error(`❌ Некорректный баланс USD: ${balanceData.balance}`);
        }
        
        const amountToSpend = (availableUSD * percentage) / 100;
        console.log(`💵 Доступно USD: $${availableUSD}, к трате: $${amountToSpend.toFixed(2)}`);

        if (amountToSpend < 1) {
            throw new Error(`❌ Сумма ордера должна быть минимум $1, а у вас: $${amountToSpend.toFixed(2)}`);
        }
        if (amountToSpend > availableUSD) {
            throw new Error(`❌ Недостаточно средств. Нужно: $${amountToSpend.toFixed(2)}, доступно: $${availableUSD}`);
        }

        // Рассчитываем размер с учетом комиссии
        const fee = 0.006;
        const amountWithFee = amountToSpend / (1 + fee);
        const rawSize = amountWithFee / bestBid;
        const incrementDecimals = productInfo.base_increment.toString().split('.')[1]?.length || 0;
        const size = Number(rawSize.toFixed(incrementDecimals));
        
        console.log(`📏 Размер ордера: ${size} ${coin}`);
        
        // Проверяем минимальный размер
        if (size < parseFloat(productInfo.base_min_size)) {
            throw new Error(`❌ Размер ордера ${size} меньше минимального ${productInfo.base_min_size} ${coin}`);
        }

        // Создаем данные ордера
        const buyOrderData = { 
            coin, 
            baseSize: size.toString(), 
            limitPrice: bestBid.toString() 
        };
        
        console.log('📤 Отправляем ордер на сервер:', buyOrderData);
        
        // Отправляем запрос на создание ордера
        const orderResponse = await fetch('/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buyOrderData)
        });
        
        if (!orderResponse.ok) {
            throw new Error(`❌ Ошибка HTTP при создании ордера: ${orderResponse.status} ${orderResponse.statusText}`);
        }
        
        const buyResult = await orderResponse.json();
        console.log('📥 Ответ сервера по ордеру:', buyResult);

        if (buyResult.success) {
            console.log('✅ Ордер успешно создан!');
            
            // Создаем объект для отображения
            const displayData = {
                orderId: buyResult.order_id || 'N/A',
                pair: `${coin}-USD`,
                side: 'buy',
                size: size.toString(),
                executedPrice: bestBid.toFixed(8),
                filledSize: size.toString(),
                totalValue: amountToSpend.toFixed(2),
                status: 'pending',
                completion: '0.00%',
                createdTime: new Date().toLocaleString(),
                price: bestBid
            };
            
            // Сохраняем созданный ордер для подсветки
            createdOrders.push(displayData);
            
            // Выводим параметры в параграф
            displayOrderParameters(displayData);
            
            // Показываем успешный alert
            alert(`✅ ОРДЕР УСПЕШНО СОЗДАН!\n\n📊 Детали:\n• Монета: ${coin}\n• Сумма: $${amountToSpend.toFixed(2)}\n• Цена: $${bestBid.toFixed(8)}\n• Размер: ${size}\n• ID: ${buyResult.order_id || 'N/A'}\n\n🎉 Ордер отправлен на биржу!`);
            
            // Обновляем данные
            console.log('🔄 Обновляем данные...');
            // Сохраняем состояние галочек ПЕРЕД обновлением таблицы
            await saveCheckboxStates();
            await loadLatestOrders();
            // Загружаем выбранные ордера перед обновлением
            await loadSelectedOrdersFromServer();
            await updateSelectedOrders();
            await updateUSDBalance();
            console.log('✅ Данные обновлены');
            
        } else {
            // Ордер НЕ создан - показываем детальную ошибку
            const errorMsg = buyResult.error || buyResult.message || 'Неизвестная ошибка сервера';
            console.error('❌ Ордер НЕ создан. Ошибка сервера:', buyResult);
            throw new Error(`❌ ОРДЕР НЕ СОЗДАН!\n\nОшибка сервера: ${errorMsg}\n\nПроверьте:\n• Подключение к бирже\n• Настройки API\n• Баланс счета`);
        }
        
    } catch (error) {
        console.error('💥 КРИТИЧЕСКАЯ ОШИБКА при создании ордера:', error);
        
        // Показываем детальное сообщение об ошибке
        const errorMessage = `🚫 ОРДЕР НЕ СОЗДАН!\n\n${error.message}\n\n🔍 Проверьте:\n• Интернет соединение\n• Работу сервера\n• Правильность данных\n• Консоль браузера (F12)`;
        
        alert(errorMessage);
        
        // Также выводим в консоль для отладки
        console.error('Стек ошибки:', error.stack);
    }
}

// Добавляем отладочную информацию после определения функции
console.log('✅ Функция createOrderFromCurrentData определена:', typeof createOrderFromCurrentData);

// Также добавьте глобальную привязку для отладки:
window.createOrderFromCurrentData = createOrderFromCurrentData;
console.log('🌐 Функция добавлена в window:', typeof window.createOrderFromCurrentData);

// Функция для отображения параметров ордера в параграфе (без Price +1% и Profit at +1%)
function displayOrderParameters(orderData) {
    // Находим или создаем контейнер для отображения
    let orderDisplayContainer = document.getElementById('orderDisplayContainer');
    if (!orderDisplayContainer) {
        orderDisplayContainer = document.createElement('div');
        orderDisplayContainer.id = 'orderDisplayContainer';
        orderDisplayContainer.className = 'order-display-container mt-4 p-4 bg-gray-100 rounded';
        
        // Вставляем после формы покупки
        const buyForm = document.querySelector('.buy-form') || document.querySelector('form');
        if (buyForm) {
            buyForm.parentNode.insertBefore(orderDisplayContainer, buyForm.nextSibling);
        } else {
            document.body.appendChild(orderDisplayContainer);
        }
    }
    
    // Создаем HTML с параметрами ордера (убираем Price +1% и Profit at +1%)
    orderDisplayContainer.innerHTML = `
        <h4 class="text-lg font-semibold mb-3">📈 Созданный ордер (Value Above Max Total - BID + Post Only)</h4>
        <div class="order-parameters bg-white p-3 rounded border">
            <p class="mb-2"><strong>Order ID (Pair):</strong> ${orderData.orderId.split('-')[0]}-... (${orderData.pair})</p>
            <p class="mb-2"><strong>Side:</strong> <span class="text-green-600">${orderData.side}</span></p>
            <p class="mb-2"><strong>Size:</strong> ${orderData.size}</p>
            <p class="mb-2"><strong>Executed Price:</strong> <span class="created-order-price" data-price="${orderData.executedPrice}">${orderData.executedPrice}</span></p>
            <p class="mb-2"><strong>Filled Size:</strong> ${orderData.filledSize}</p>
            <p class="mb-2"><strong>Total Value:</strong> $${orderData.totalValue}</p>
            <p class="mb-2"><strong>Status:</strong> <span class="text-green-600">${orderData.status}</span></p>
            <p class="mb-2"><strong>Completion:</strong> <span class="text-green-600">${orderData.completion}</span></p>
            <p class="mb-0"><strong>Created Time:</strong> ${orderData.createdTime}</p>
        </div>
        <div class="mt-3 text-sm text-gray-600">
            <p>💡 Стратегия: Value Above Max Total (BID) for ${orderData.pair.split('-')[0]}-USD + Post Only</p>
        </div>
    `;
    
    // Прокручиваем к созданному ордеру
    orderDisplayContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Handle order creation
window.handleOrderCreated = async response => {
    console.log('Order created response:', response);
    if (response.success) {
        // Save checkbox states before reloading
        await saveCheckboxStates();
        await loadLatestOrders();
        // Restore checkbox states after loading
        await loadSelectedOrdersFromServer();
        await updateSelectedOrders();
        await updateUSDBalance();
    }
};