let currentOrders = new Map();
let ws;
const productInfoCache = new Map();

// Глобальная переменная для хранения созданных ордеров
let createdOrders = [];

// Фиксированный Best Ask по каждой паре (снимок при первом апдейте)
const fixedBestAskByPair = new Map();

// Вспомогательная: количество знаков после точки в тексте цены ('$3.184' -> 3)
function getDecimalPlacesFromText(text) {
    try {
        const cleaned = String(text || '').replace(/[^\d.]/g, '');
        const dotIdx = cleaned.indexOf('.');
        if (dotIdx === -1) return 0;
        const fraction = cleaned.slice(dotIdx + 1);
        return fraction.length;
    } catch (e) {
        console.warn('getDecimalPlacesFromText error:', e);
        return 2;
    }
}

// Получить требуемое количество знаков для пары из ячейки Best Ask,
// иначе из текущего Fixed Ask, иначе дефолт (2)
function getDecimalsForPair(pair) {
    try {
        const askCell = document.querySelector(`.best-ask-cell[data-pair="${pair}"]`);
        if (askCell && askCell.textContent && !/Loading|Error/i.test(askCell.textContent)) {
            const d = getDecimalPlacesFromText(askCell.textContent);
            if (Number.isFinite(d) && d >= 0) return d;
        }
        const fallbackText =
            fixedBestAskByPair.get(pair) ||
            document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`)?.textContent ||
            '';
        const d2 = getDecimalPlacesFromText(fallbackText);
        return d2 || 2;
    } catch (e) {
        console.warn('getDecimalsForPair error:', e);
        return 2;
    }
}

// Изменить Fixed Ask на заданный процент (например, +0.1 или -0.1)
function adjustFixedAskByPercent(pair, percentDelta) {
    try {
        if (!pair) return;
        if (!shouldRefreshForPair(pair)) return;

        const decimals = getDecimalsForPair(pair);

        const baseText =
            fixedBestAskByPair.get(pair) ||
            document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`)?.textContent ||
            '';

        const current = parseFloat(String(baseText).replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(current)) return;

        const factor = 1 + (percentDelta / 100); // 0.1% -> 0.001
        const next = current * factor;
        const nextText = `$${next.toFixed(decimals)}`;

        // Сохраняем и обновляем все связанные ячейки
        fixedBestAskByPair.set(pair, nextText);
        document.querySelectorAll(`.best-ask-fixed-cell[data-pair="${pair}"]`).forEach(cell => {
            cell.textContent = nextText;
            cell.style.transition = 'background-color 0.3s ease';

            if (percentDelta >= 0) {
                // Плюс: фиксируем зелёный фон (без отката)
                cell.style.backgroundColor = 'rgba(16, 185, 129, 0.35)';
            } else {
                // Минус: краткая тёмно-красная подсветка с возвратом к прежнему фону
                const prev = cell.style.backgroundColor;
                cell.style.backgroundColor = 'rgba(239, 68, 68, 0.35)';
                setTimeout(() => { cell.style.backgroundColor = prev || ''; }, 600);
            }
        });

        // Пересчитать Fixed Profit после изменения цены
        updateFixedProfitForPair(pair);
        // NEW: also refresh Fixed Ask shown in Sell form
        updateSellFixedAskPrice();
        // NEW: обновить колонку сравнения с первым ордером
        updateFixedAskVsFirstDiffForPair(pair);
    } catch (e) {
        console.warn('adjustFixedAskByPercent error:', e);
    }
}

// Пересчет фиксированной прибыли для пары (продажа по Fixed Ask)
function updateFixedProfitForPair(pair) {
    try {
        const cells = document.querySelectorAll(`.profit-fixed-cell[data-pair="${pair}"]`);
        if (!cells.length) return;

        const fixedText =
            fixedBestAskByPair.get(pair) ||
            document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`)?.textContent ||
            '';
        const fixedPrice = parseFloat(String(fixedText).replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(fixedPrice)) return;

        cells.forEach(cell => {
            const row = cell.closest('tr');
            const sizeEl = row?.querySelector('.summary-filled-size') || row?.querySelector('td:nth-child(5)');
            const usdEl = row?.querySelector('.summary-total-usd') || row?.querySelector('td:nth-child(6)');
            const totalFilledSize = parseFloat(sizeEl?.textContent || '');
            const totalValue = parseFloat(usdEl?.textContent || '');

            if (Number.isFinite(totalFilledSize) && Number.isFinite(totalValue)) {
                const potentialValue = fixedPrice * totalFilledSize;
                const afterFees = potentialValue * (1 - (window?.FEES?.PROFIT_LIMIT ?? 0));
                const profit = afterFees - totalValue;
                const formatted = profit.toFixed(2);
                cell.textContent = formatted;
                cell.classList.remove('positive', 'negative', 'error');
                if (profit > 0) {
                    cell.classList.add('positive');
                } else if (profit < 0) {
                    cell.classList.add('negative');
                }
            } else {
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });
    } catch (e) {
        console.warn('updateFixedProfitForPair error:', e);
    }
}


// NEW: процентное отклонение Fixed Ask от цены первого ордера по паре
function updateFixedAskVsFirstDiffForPair(pair) {
    try {
        const cells = document.querySelectorAll(`.fixed-ask-vs-first-cell[data-pair="${pair}"]`);
        if (!cells.length) return;

        const fixedText =
            fixedBestAskByPair.get(pair) ||
            document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`)?.textContent ||
            '';
        const fixedPrice = parseFloat(String(fixedText).replace(/[^0-9.]/g, ''));

        const firstExecutedText = document.querySelector(`.first-executed-price[data-pair="${pair}"]`)?.textContent || '';
        const firstExecutedPrice = parseFloat(String(firstExecutedText).replace(/[^0-9.]/g, ''));

        if (!Number.isFinite(fixedPrice) || !Number.isFinite(firstExecutedPrice) || firstExecutedPrice === 0) {
            cells.forEach(cell => {
                cell.textContent = '—';
                cell.classList.remove('positive', 'negative');
                cell.classList.add('error');
            });
            return;
        }

        const diffPercent = ((fixedPrice - firstExecutedPrice) / firstExecutedPrice) * 100;
        const formatted = `${diffPercent >= 0 ? '+' : ''}${diffPercent.toFixed(2)}%`;

        cells.forEach(cell => {
            cell.textContent = formatted;
            cell.classList.remove('positive', 'negative', 'error');
            if (diffPercent > 0) {
                cell.classList.add('positive');
            } else if (diffPercent < 0) {
                cell.classList.add('negative');
            }
        });
    } catch (e) {
        console.warn('updateFixedAskVsFirstDiffForPair error:', e);
    }
}

// Определить активную пару: сначала из форм Sell/Buy, затем из активной строки таблицы
function getActivePair() {
    // Сначала пробуем получить из формы продажи (Sell)
    const sellCoin = (document.getElementById('sellCoinInput')?.value || '').trim().toUpperCase();
    if (sellCoin) return `${sellCoin}-USD`;

    // Затем из формы покупки (Buy)
    const buyCoin = (document.getElementById('coinInput')?.value || '').trim().toUpperCase();
    if (buyCoin) return `${buyCoin}-USD`;

    // Fallback: активная строка таблицы Selected Orders или общая активная строка
    const activeRow = document.querySelector('.selected-orders-container tr.active-row') 
                   || document.querySelector('tr.active-row');
    const container = activeRow ? activeRow.closest('.coin-orders-table') 
                                : document.querySelector('.coin-orders-table');
    const askCell = container?.querySelector('.best-ask-cell[data-pair]');
    const fromActive = askCell?.dataset.pair || null;

    return fromActive || null;
}

// Вспомогательная: извлечь базовую монету из текста пары (например, FIL из FIL-USD)
function extractBaseCoinFromPair(pairText) {
    const text = String(
        typeof pairText === 'string' ? pairText : (pairText?.textContent || '')
    ).toUpperCase().trim();
    const match = text.match(/^([A-Z0-9]+)[-/]/); // поддержка разделителей '-' и '/'
    return match ? match[1] : text;
}

// Проверка: обновлять Fixed Ask только если выбранная пара совпадает с монетой в Sell-форме
function shouldRefreshForPair(pairText) {
    try {
        if (!pairText) return false;
        const baseCoin = extractBaseCoinFromPair(pairText);
        const sellCoin = (document.getElementById('sellCoinInput')?.value || '').trim().toUpperCase();
        // Требуется совпадение только с монетой в Sell-форме
        return !!baseCoin && !!sellCoin && baseCoin === sellCoin;
    } catch (e) {
        console.warn('shouldRefreshForPair error:', e);
        return false;
    }
}

// Обновить Fixed Ask: получить текущий ask, подсветить ячейку и скопировать цену
async function refreshFixedAsk(pairText) {
    // Защита: выполняем обновление только если монета совпадает в обеих формах
    if (!shouldRefreshForPair(pairText)) {
        console.warn('refreshFixedAsk skipped: active coin does not match both buy and sell forms');
        return;
    }
    try {
        const res = await fetch(`https://api.exchange.coinbase.com/products/${pairText}/ticker`);
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        if (!data?.ask) throw new Error('Invalid price data');

        const newAskText = `$${data.ask}`;
        fixedBestAskByPair.set(pairText, newAskText);

        document.querySelectorAll(`.best-ask-fixed-cell[data-pair="${pairText}"]`).forEach(async (cell) => {
            cell.textContent = newAskText;
            // Короткая подсветка изменения
            const prev = cell.style.backgroundColor;
            cell.style.transition = 'background-color 0.4s ease';
            cell.style.backgroundColor = 'rgba(16, 185, 129, 0.35)';
            setTimeout(() => { cell.style.backgroundColor = prev || ''; }, 600);

            // Копирование в буфер как числового значения
            const numericPrice = newAskText.replace(/[^0-9.]/g, '');
            try {
                await navigator.clipboard.writeText(numericPrice);
            } catch (copyErr) {
                console.warn('Clipboard write failed:', copyErr);
            }
        });

        // После обновления Fixed Ask пересчитываем Fixed Profit
        updateFixedProfitForPair(pairText);
        // NEW: keep Sell form in sync
        updateSellFixedAskPrice();
        // NEW: обновить колонку сравнения с первым ордером
        updateFixedAskVsFirstDiffForPair(pairText);

        // Кастомный алерт справа сверху
        showCustomAlert(`Fixed Ask обновлён и скопирован: ${newAskText}`);
    } catch (error) {
        console.error('Failed to refresh Fixed Ask:', error);
        document.querySelectorAll(`.best-ask-fixed-cell[data-pair="${pairText}"]`).forEach(cell => {
            if (!cell.textContent || cell.textContent === 'Loading...') {
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });
        showCustomAlert('Не удалось обновить Fixed Ask', true);
    }
}

// Hide legacy bot analysis blocks (in case browser has cached old HTML)
document.addEventListener('DOMContentLoaded', () => {
    ['.bot-inds', '.bot-pos', '.bot-bottom', '.bot-hist-toggle', '#botHistWrap', '#botPosRow'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
    });
});

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
    console.log('Page loaded, initializing...');

    try {
        // Load orders
        const latestOrders = await loadLatestOrders();
        console.log('Orders loaded');

        // Определяем монету из первой записи Latest Orders, иначе fallback на BTC
        const firstCoinFromLatest = Array.isArray(latestOrders) && latestOrders.length
            ? String(latestOrders[0].product_id || '').split('-')[0]
            : 'BTC';

        // Убираем автоматическую активацию первой строки при загрузке

        // Load selected orders from server FIRST
        await loadSelectedOrdersFromServer();
        
        // Update selected orders
        await updateSelectedOrders();
        console.log('Selected orders updated');

        // Set default coin for forms (from Latest Orders)
        const buyInput = document.getElementById('coinInput');
        const sellInput = document.getElementById('sellCoinInput');
        const percentageInput = document.getElementById('percentageInput');

        if (buyInput) {
            buyInput.value = firstCoinFromLatest;
            if (percentageInput) {
                percentageInput.value = '100';
                document.querySelectorAll('.percentage-button').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.value === '100');
                });
            }
            await updateBestBidForBuyForm();
            await updatePurchaseAmount();
            await updateStopLimitPrices();
        }

        if (sellInput) {
            sellInput.value = firstCoinFromLatest;
            await updateBestAskPrice();
            await updateSellPurchaseAmount();
            // NEW: initialize Fixed Ask preview in Sell form
            updateSellFixedAskPrice();
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
        
        // Initialize price alerts
        initializePriceAlerts();
        attachAlertHandlers();
        
        // Запускаем polling для обработки callback'ов
        pollTelegramUpdates();
        highlightSelectedCoinTitle();
    } catch (error) {
        console.error('Initialization error:', error);
    }
});

// Setup event listeners
function setupEventListeners() {
    const groqBtn = document.getElementById('groqAskBtn');
    const groqPrompt = document.getElementById('groqPrompt');
    const groqAnswer = document.getElementById('groqAnswer');
    groqBtn?.addEventListener('click', async () => {
        if (!groqPrompt || !groqAnswer) return;
        const prompt = groqPrompt.value.trim();
        if (!prompt) { groqAnswer.textContent = 'Введите запрос'; return; }
        groqBtn.disabled = true;
        groqAnswer.textContent = 'Запрос отправляется...';
        try {
            const resp = await fetch('/api/groq/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
            const data = await resp.json();
            groqAnswer.textContent = data.success ? data.text : `Ошибка: ${data.error || 'Не удалось получить ответ'}`;
        } catch (e) {
            groqAnswer.textContent = `Ошибка сети: ${e.message}`;
        } finally {
            groqBtn.disabled = false;
        }
    });
    groqPrompt?.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'Enter') groqBtn?.click();
    });
    // Coin input handlers
    const coinInput = document.getElementById('coinInput');
    if (coinInput) {
        let inputTimeout;
        coinInput.addEventListener('input', async function () {
            this.value = this.value.toUpperCase();
            clearTimeout(inputTimeout);
            inputTimeout = setTimeout(async () => {
                if (this.value.length >= 2) {
                    try {
                        await updateBestBidForBuyForm();
                        await updatePurchaseAmount();
                        await updateStopLimitPrices();
                        highlightSelectedCoinTitle();
                    } catch (error) {
                        console.error('Error updating prices:', error);
                    }
                }
            }, 800);
        });
    }

    document.getElementById('sellCoinInput')?.addEventListener('input', async function () {
        this.value = this.value.toUpperCase();
        let sellInputTimeout;
        clearTimeout(sellInputTimeout);
        sellInputTimeout = setTimeout(async () => {
            if (this.value.length >= 3) {
                try {
                    await updateBestAskPrice();
                    await updateSellPurchaseAmount();
                    updateSellFixedAskPrice();
                    highlightSelectedCoinTitle();
                } catch (error) {
                    console.error('Error updating price:', error);
                }
            } else {
                const bestAskElement = document.getElementById('bestAskPrice');
                if (bestAskElement) bestAskElement.textContent = 'Enter coin symbol (min 3 chars)';
            }
        }, 800);
    });

    // Глобальные хоткеи: '*' — обновление с рынка; '+'/'-' — ±0.1% к Fixed Ask
    document.addEventListener('keydown', async (e) => {
        if (
            e.code === 'NumpadMultiply' || e.key === '*' ||
            e.code === 'NumpadAdd'      || e.key === '+' ||
            e.code === 'NumpadSubtract' || e.key === '-'
        ) {
            e.preventDefault();
            const activePair = getActivePair();
            if (!activePair) {
                console.warn('Не удалось определить активную пару для хоткея');
                return;
            }
            if (!shouldRefreshForPair(activePair)) {
                console.warn('Хоткей пропущен: монета активной пары не совпадает с Buy и Sell');
                return;
            }

            if (e.code === 'NumpadMultiply' || e.key === '*') {
                await refreshFixedAsk(activePair);
            } else if (e.code === 'NumpadAdd' || e.key === '+') {
                adjustFixedAskByPercent(activePair, 0.1);  // +0.1%
            } else if (e.code === 'NumpadSubtract' || e.key === '-') {
                adjustFixedAskByPercent(activePair, -0.1); // -0.1%
            }
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
            const baseIncrement = parseFloat(productInfo.base_increment);
            const sizeDecimals = productInfo.base_increment.toString().split('.')[1]?.length || 0;
            const priceDecimals = productInfo.quote_increment.toString().split('.')[1]?.length || 0;
            const rawSize = Math.floor(amountWithFee / bestBid / baseIncrement) * baseIncrement;
            const size = Number(rawSize.toFixed(sizeDecimals));
            const limit = Number(bestBid.toFixed(priceDecimals));

            const buyOrderData = { coin, baseSize: size.toString(), limitPrice: limit.toString() };
            const buyResult = await (await fetch('/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buyOrderData)
            })).json();

            if (buyResult.success) {
                await loadLatestOrders();
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
            const quoteIncrement = parseFloat(productInfo.quote_increment);
            const sizeDecimals = productInfo.base_increment.toString().split('.')[1]?.length || 0;
            const priceDecimals = productInfo.quote_increment.toString().split('.')[1]?.length || 0;

            // Округляем размер вниз к шагу и фиксируем количество знаков
            const rawSize = Math.floor(amountToSell / baseIncrement) * baseIncrement;
            const size = Number(rawSize.toFixed(sizeDecimals));
            const limit = Number(bestAsk.toFixed(priceDecimals));

            // Проверяем минимальный размер, если указан
            const minSize = parseFloat(productInfo.base_min_size || '0');
            if (minSize && size < minSize) {
                throw new Error(`Order size ${size} is below minimum ${minSize}`);
            }

            const sellOrderData = { coin, baseSize: size.toString(), limitPrice: limit.toString(), side: 'SELL' };
            const sellResult = await (await fetch('/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sellOrderData)
            })).json();

            if (sellResult.success) {
                await loadLatestOrders();
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

    // NEW: Sell by Fixed Ask button
    document.getElementById('sellFixedButton')?.addEventListener('click', async () => {
        const button = document.getElementById('sellFixedButton');
        button.disabled = true;
        try {
            const coin = document.getElementById('sellCoinInput').value.toUpperCase();
            const productInfo = await getProductInfo(coin);

            const fixedAskText = document.getElementById('sellFixedAskPrice')?.textContent || '';
            const fixedAsk = parseFloat(String(fixedAskText).replace('$', ''));
            if (isNaN(fixedAsk)) throw new Error('Invalid Fixed Ask price');

            const percentage = parseInt(document.getElementById('sellPercentageInput').value);
            const balanceData = await (await fetch(`/get-coin-balance/${coin}`)).json();
            if (!balanceData.success) throw new Error('Could not get coin balance');

            const availableCoin = parseFloat(String(balanceData.balance ?? '0')) || 0;

            const pair = getActivePair() || `${coin}-USD`;
            let summaryRow = document.querySelector(`.profit-fixed-cell[data-pair="${pair}"]`)?.closest('tr');
            if (!summaryRow) {
                const fixedCell = document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`);
                summaryRow = fixedCell?.closest('tr') || null;
            }
            const summaryFilledSizeEl = summaryRow?.querySelector('.summary-filled-size');
            const summaryFilledSize = parseFloat(summaryFilledSizeEl?.textContent || '') || 0;

            const sourceAmount = availableCoin > 0 ? availableCoin : summaryFilledSize;
            const amountToSell = (sourceAmount * percentage) / 100;
            if (amountToSell <= 0) throw new Error('No FIL to sell');

            const valueInUSD = amountToSell * fixedAsk;
            if (valueInUSD < 1) throw new Error('Order value must be at least $1');

            const baseIncrement = parseFloat(productInfo.base_increment);
            const quoteIncrement = parseFloat(productInfo.quote_increment);
            const sizeDecimals = productInfo.base_increment.toString().split('.')[1]?.length || 0;
            const priceDecimals = productInfo.quote_increment.toString().split('.')[1]?.length || 0;

            const rawSize = Math.floor(amountToSell / baseIncrement) * baseIncrement;
            const size = Number(rawSize.toFixed(sizeDecimals));
            const limit = Number(fixedAsk.toFixed(priceDecimals));

            const minSize = parseFloat(productInfo.base_min_size || '0');
            if (minSize && size < minSize) {
                throw new Error(`Order size ${size} is below minimum ${minSize}`);
            }

            const sellOrderData = { coin, baseSize: size.toString(), limitPrice: limit.toString(), side: 'SELL' };
            const sellResult = await (await fetch('/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(sellOrderData)
            })).json();

            if (sellResult.success) {
                await loadLatestOrders();
                await updateUSDBalance();
            } else {
                throw new Error(sellResult.error || 'Failed to create sell order');
            }
        } catch (error) {
            console.error('Error creating sell order (fixed):', error);
            alert(`Error creating sell order (fixed): ${error.message}`);
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

            const priceIncrement = parseFloat(productInfo.quote_increment);
            
            // Stop Price = лучшая bid цена + один шаг цены
            const stopPrice = bestBid + priceIncrement;
            // Limit Price = Stop Price + один шаг цены
            const limitPrice = stopPrice + priceIncrement;
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
                await loadLatestOrders();
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
        
        // Для полей ввода блокируем ВСЕ обработчики клавиш
        if (e.target.matches('input, textarea')) {
            console.log('⚠️ Фокус на поле ввода, блокируем ВСЕ обработчики клавиш');
            return;
        }
        
        // УБИРАЕМ обработчик клавиши S для создания ордеров
        // Ордера создаются только через кнопки!

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
                        // NEW: ensure Sell Fixed Ask preview updates immediately for active pair
                        updateSellFixedAskPrice();
                        highlightSelectedCoinTitle();
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
                    // Проверяем, есть ли уже активное уведомление для этого ордера
                    const existingAlerts = getAllPriceAlerts();
                    const alertExists = Object.values(existingAlerts).some(alert => alert.orderId === orderId);
                    
                    // Если уведомления нет, создаем его (нажимаем кнопку Telegram)
                    if (!alertExists) {
                        console.log('🔔 Enter нажат на активной строке, создаем уведомление для ордера:', orderId);
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
                    // ИСПРАВЛЕНО: правильный селектор контейнера
                    const selectedOrderRow = document.querySelector(`#selectedOrdersContainer tr[data-order-id="${orderId}"]`);
                    if (selectedOrderRow) {
                        document.querySelectorAll('#selectedOrdersContainer tr.active-row').forEach(row => row.classList.remove('active-row'));
                        selectedOrderRow.classList.add('active-row');
                    }
                    highlightSelectedCoinTitle();
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
        const coinStatusElement = document.getElementById('coinStatus');
        
        if (!coin) {
            if (coinStatusElement) coinStatusElement.textContent = '';
            return;
        }

        const response = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`);
        
        if (response.ok) {
            const data = await response.json();
            const bestBidElement = document.getElementById('bestBidPrice');
            
            if (bestBidElement && data.bid) {
                bestBidElement.textContent = `$${parseFloat(data.bid).toFixed(8)}`;
            }
            
            // Показываем что монета найдена
            if (coinStatusElement) {
                coinStatusElement.textContent = `✅ Coin ${coin} found on Coinbase`;
                coinStatusElement.style.color = 'green';
            }
        } else {
            // Показываем что монета не найдена
            if (coinStatusElement) {
                coinStatusElement.textContent = `❌ Монета ${coin} not found on Coinbase`;
                coinStatusElement.style.color = 'red';
            }
        }
    } catch (error) {
        console.error('Error fetching best bid:', error);
        const coinStatusElement = document.getElementById('coinStatus');
        if (coinStatusElement) {
            const coin = document.getElementById('coinInput').value.toUpperCase();
            coinStatusElement.textContent = `❌ Монета ${coin} not found on Coinbase`;
            coinStatusElement.style.color = 'red';
        }
    }
}

async function updateBestAskPrice() {
    try {
        const coin = document.getElementById('sellCoinInput').value.toUpperCase();
        const sellCoinStatusElement = document.getElementById('sellCoinStatus');
        
        if (!coin) {
            if (sellCoinStatusElement) sellCoinStatusElement.textContent = '';
            return;
        }

        const response = await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`);
        
        if (response.ok) {
            const data = await response.json();
            const bestAskElement = document.getElementById('bestAskPrice');
            
            if (bestAskElement && data.ask) {
                bestAskElement.textContent = `$${parseFloat(data.ask).toFixed(8)}`;
            }
            
            // Показываем что монета найдена
            if (sellCoinStatusElement) {
                sellCoinStatusElement.textContent = `✅ Coin ${coin} found on Coinbase`;
                sellCoinStatusElement.style.color = 'green';
            }

            // NEW: auto-update sell amount when price fetched
            await updateSellPurchaseAmount();
        } else {
            // Показываем что монета не найдена
            if (sellCoinStatusElement) {
                sellCoinStatusElement.textContent = `❌ Coin ${coin} not found on Coinbase`;
                sellCoinStatusElement.style.color = 'red';
            }
        }
    } catch (error) {
        console.error('Error fetching best ask:', error);
        const sellCoinStatusElement = document.getElementById('sellCoinStatus');
        if (sellCoinStatusElement) {
            const coin = document.getElementById('sellCoinInput').value.toUpperCase();
            sellCoinStatusElement.textContent = `❌ Coin ${coin} not found on Coinbase`;
            sellCoinStatusElement.style.color = 'red';
        }
    }
}

// NEW: show Fixed Ask from table in the Sell form
function updateSellFixedAskPrice() {
    try {
        const target = document.getElementById('sellFixedAskPrice');
        const sellBtn = document.getElementById('sellFixedButton');
        const profitEl = document.getElementById('sellFixedProfit');
        if (!target) return;

        const activePair = getActivePair();
        const sellCoin = (document.getElementById('sellCoinInput')?.value || '').trim().toUpperCase();
        const pair = sellCoin ? `${sellCoin}-USD` : (activePair ?? null);
        const zero = '$0.00';

        if (!pair) {
            target.textContent = zero;
            if (sellBtn) sellBtn.textContent = 'Sell Limit Fixed Ask';
            if (profitEl) {
                profitEl.textContent = '0.00';
                profitEl.classList.remove('positive', 'negative', 'error');
            }
            return;
        }

        // Fixed Ask: берём из сохранённой карты или ячейки таблицы
        const fixedText =
            fixedBestAskByPair.get(pair) ||
            document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`)?.textContent ||
            '';

        const displayText =
            (fixedText && fixedText !== 'Loading...' && fixedText !== 'Error')
                ? fixedText
                : (document.getElementById('bestAskPrice')?.textContent || zero);

        target.textContent = displayText;
        if (sellBtn) sellBtn.textContent = `Sell Limit Fixed Ask (${displayText})`;

        // NEW: подтягиваем Fixed Profit из таблицы (или считаем при необходимости)
        if (profitEl) {
            const profitCell = document.querySelector(`.profit-fixed-cell[data-pair="${pair}"]`);
            let profitText = profitCell?.textContent?.trim() || '';

            // Если таблица ещё не успела посчитать — считаем на лету
            if (!profitText || ['Calc...', 'Loading...', 'Error'].includes(profitText)) {
                const numericAsk = parseFloat(String(displayText).replace(/[^0-9.]/g, ''));
                // Найти строку summary (содержит summary-filled-size/summary-total-usd)
                let summaryRow = profitCell?.closest('tr');
                if (!summaryRow) {
                    const fixedCell = document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`);
                    summaryRow = fixedCell?.closest('tr') || null;
                }
                const sizeEl = summaryRow?.querySelector('.summary-filled-size') || summaryRow?.querySelector('td:nth-child(5)');
                const usdEl = summaryRow?.querySelector('.summary-total-usd') || summaryRow?.querySelector('td:nth-child(6)');
                const totalFilledSize = parseFloat(sizeEl?.textContent || '');
                const totalValue = parseFloat(usdEl?.textContent || '');
                const fee = (window?.FEES?.PROFIT_LIMIT ?? 0);

                if (Number.isFinite(numericAsk) && Number.isFinite(totalFilledSize) && Number.isFinite(totalValue)) {
                    const potentialValue = numericAsk * totalFilledSize;
                    const afterFees = potentialValue * (1 - fee);
                    const profit = afterFees - totalValue;
                    profitText = profit.toFixed(2);
                } else {
                    profitText = '0.00';
                }
            }

            profitEl.textContent = profitText;
            profitEl.classList.remove('positive', 'negative', 'error');
            const numericProfit = parseFloat(profitText);
            if (Number.isFinite(numericProfit)) {
                if (numericProfit > 0) profitEl.classList.add('positive');
                else if (numericProfit < 0) profitEl.classList.add('negative');
            } else {
                profitEl.classList.add('error');
            }
        }
    } catch (e) {
        console.warn('updateSellFixedAskPrice error:', e);
    }
}

// Новое: Подсветка заголовка монеты в левом списке по выбранной паре
function highlightSelectedCoinTitle() {
    try {
        const sellCoin = (document.getElementById('sellCoinInput')?.value || '').trim().toUpperCase();
        const buyCoin  = (document.getElementById('coinInput')?.value || '').trim().toUpperCase();
        const pairFromForm = sellCoin ? `${sellCoin}-USD` : (buyCoin ? `${buyCoin}-USD` : null);

        // ИСПРАВЛЕНО: правильный селектор контейнера выбранных ордеров
        const activeRow = document.querySelector('#selectedOrdersContainer tr.active-row');
        const pairFromRow = activeRow?.querySelector('[data-pair]')?.getAttribute('data-pair') || null;

        const targetPair = pairFromForm || pairFromRow || null;

        document.querySelectorAll('.coin-orders-table').forEach(table => {
            // ИСПРАВЛЕНО: сперва пробуем явный data-pair, fallback на текст
            const pairText = table.querySelector('h4 [data-pair]')?.getAttribute('data-pair')
                || table.querySelector('h4 a')?.textContent?.trim();
            if (targetPair && pairText && pairText.toUpperCase() === targetPair.toUpperCase()) {
                table.classList.add('active-coin');
            } else {
                table.classList.remove('active-coin');
            }
        });
    } catch (e) {
        console.warn('highlightSelectedCoinTitle error:', e);
    }
}

async function updateStopLimitPrices() {
    const bestBid = parseFloat(document.getElementById('bestBidPrice').textContent.replace('$', ''));
    const coin = document.getElementById('coinInput').value.toUpperCase();
    
    if (!isNaN(bestBid) && coin) {
        try {
            const productInfo = await getProductInfo(coin);
            const priceIncrement = parseFloat(productInfo.quote_increment);
            
            // Stop Price = лучшая bid цена + один шаг цены
            const stopPrice = bestBid + priceIncrement;
            // Limit Price = Stop Price + один шаг цены
            const limitPrice = stopPrice + priceIncrement;
            
            document.getElementById('stopPrice').textContent = `$${stopPrice.toFixed(8)}`;
            document.getElementById('limitPrice').textContent = `$${limitPrice.toFixed(8)}`;
            
            // Обновляем текст кнопки с актуальным шагом цены
            const button = document.getElementById('buyStopLimitButton');
            if (button) {
                button.textContent = `Buy Stop Limit +${priceIncrement}`;
            }
        } catch (error) {
            console.error('Error updating stop limit prices:', error);
        }
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
        // Проверяем выбранные ордера ДО обновления таблицы
        const hasSelectedOrders = Array.from(currentOrders.values()).some(order => order.isSelected);

        // Обновляем таблицу (состояние isSelected хранится в currentOrders и сохраняется)
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
    
    // ИСПРАВЛЕНИЕ 1: Сохраняем состояние чекбоксов ДО очистки таблицы
    const currentSelectionStates = new Map();
    document.querySelectorAll('.order-selector').forEach(selector => {
        const orderId = selector.getAttribute('data-order-id');
        const isSelected = selector.classList.contains('selected');
        if (orderId) {
            currentSelectionStates.set(orderId, isSelected);
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

    // ИСПРАВЛЕНИЕ 2: Улучшенная логика проверки изменений для промежуточных обновлений
    if (checkForChanges) {
        const existingRows = Array.from(tableBody.querySelectorAll('tr[data-order-id]'));
        const existingOrderIds = existingRows.map(row => row.getAttribute('data-order-id'));
        const newOrderIds = sortedOrders.map(order => order.order_id);
        
        // Проверяем изменения в статусе заполнения ордеров
        let hasStatusChanges = false;
        sortedOrders.forEach(order => {
            const existingOrder = currentOrders.get(order.order_id);
            if (existingOrder) {
                // Проверяем изменения в filled_size или completion_percentage
                const filledSizeChanged = parseFloat(existingOrder.filled_size || 0) !== parseFloat(order.filled_size || 0);
                const completionChanged = parseFloat(existingOrder.completion_percentage || 0) !== parseFloat(order.completion_percentage || 0);
                const statusChanged = existingOrder.status !== order.status;
                
                if (filledSizeChanged || completionChanged || statusChanged) {
                    hasStatusChanges = true;
                }
            }
        });
        
        // Проверяем, есть ли реальные изменения
        const hasRealChanges = existingOrderIds.length !== newOrderIds.length || 
            !existingOrderIds.every(id => newOrderIds.includes(id)) ||
            hasStatusChanges;
            
        if (!hasRealChanges) {
            // Обновляем только измененные ордера без полной перерисовки
            sortedOrders.forEach(order => {
                const existingOrder = currentOrders.get(order.order_id);
                if (existingOrder) {
                    // Сохраняем состояние чекбокса
                    order.isSelected = existingOrder.isSelected;
                }
                newOrders.set(order.order_id, order);
            });
            currentOrders = newOrders;
            return;
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
        
        // ИСПРАВЛЕНО: Используем сохраненное состояние чекбоксов
        if (existingOrder && existingOrder.isSelected !== undefined) {
            order.isSelected = existingOrder.isSelected;
        } else if (currentSelectionStates.has(order.order_id)) {
            // Используем состояние, сохраненное ДО очистки DOM
            order.isSelected = currentSelectionStates.get(order.order_id);
        } else {
            order.isSelected = false;
        }
        
        newOrders.set(order.order_id, order);

        const isNewOrder = !existingOrder;
        const hasChanged = isNewOrder || JSON.stringify(existingOrder) !== JSON.stringify(order);
        const isOpenOrder = order.status === 'OPEN';

        const row = document.createElement('tr');
        row.id = `order-${order.order_id}`;
        row.setAttribute('data-order-id', order.order_id);
        row.classList.add('order-row');
        
        // ИСПРАВЛЕНИЕ 3: Подсветка изменений в заполнении ордера
        if (hasChanged) {
            row.classList.add('order-updated');
            setTimeout(() => row.classList.remove('order-updated'), 1000);
        }
        
        // Специальная подсветка для частично заполненных ордеров
        const completionPercentage = parseFloat(order.completion_percentage || 0);
        if (completionPercentage > 0 && completionPercentage < 100 && order.status === 'OPEN') {
            row.classList.add('partially-filled');
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
                     data-order-id="${order.order_id}"
                     onclick="handleSelectorClick(this, '${order.order_id}')"
                     id="selector-${order.order_id}">
                    <span class="selector-icon">✓</span>
                </div>
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
            <td class="completion-cell ${parseFloat(order.completion_percentage || 0) === 100 ? 'completion-filled' :
                (parseFloat(order.completion_percentage || 0) > 0 && order.status === 'OPEN' ? 'completion-partial' : '')}" 
                style="--completion-width: ${order.completion_percentage || 0}%">
                <span>${order.completion_percentage || 0}%</span>
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
    
    // Переинициализируем обработчики уведомлений после обновления таблицы
    reinitializeAlerts();
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
            await loadLatestOrders();
            
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
            
            // Убираем saveCheckboxStates() - состояние уже восстановлено программно
            // saveCheckboxStates(); // УДАЛИТЬ ЭТУ СТРОКУ
            await updateSelectedOrders();
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
        // ИСПРАВЛЕНО: правильный селектор контейнера
        const selectedOrderRow = document.querySelector(`#selectedOrdersContainer tr[data-order-id="${orderId}"]`);
        if (selectedOrderRow) {
            document.querySelectorAll('#selectedOrdersContainer tr.active-row')
                .forEach(r => r.classList.remove('active-row'));
            selectedOrderRow.classList.add('active-row');
        }
    }
    highlightSelectedCoinTitle();
}

// Checkbox state management
function saveCheckboxStates() {
    const selectedIds = [];
    
    currentOrders.forEach(order => {
        if (order.isSelected) {
            selectedIds.push(order.order_id);
        }
    });
    
    // Сохраняем в файл через сервер
    fetch('/save-selected-orders', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orderIds: selectedIds })
    }).catch(error => {
        console.error('Error saving selected orders to server:', error);
    });
    
    // Сохраняем в Firebase
    import('./database.js').then(({ saveSelectedOrders }) => {
        saveSelectedOrders(selectedIds).catch(error => {
            console.error('Error saving selected orders to Firebase:', error);
        });
    }).catch(error => {
        console.error('Error importing database module:', error);
    });
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
        
        // Импортируем функцию из database.js
        const { loadSelectedOrdersFromFirebase } = await import('./database.js');
        const firebaseResult = await loadSelectedOrdersFromFirebase();
        
        if (firebaseResult.success && Array.isArray(firebaseResult.orderIds) && firebaseResult.orderIds.length > 0) {
            console.log('Loading selected orders from Firebase:', firebaseResult.orderIds);
            
            // Mark orders as selected in UI
            currentOrders.forEach(order => {
                if (firebaseResult.orderIds.includes(order.order_id)) {
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
            
            console.log('Selected orders loaded from Firebase and UI updated');
        } else if (!firebaseResult.success) {
            console.warn('Failed to load from Firebase, falling back to server:', firebaseResult.error);
            
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
            console.log('No selected orders found in Firebase');
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

// Formatting functions for profit-table
function fmtPrice(val) {
    if (val === null || val === undefined || isNaN(val)) return '0.00';
    const num = parseFloat(val);
    if (num >= 1000) return num.toFixed(2);
    if (num >= 1) return num.toFixed(4);
    if (num >= 0.01) return num.toFixed(6);
    return num.toFixed(8);
}

function fmtSize(val) {
    if (val === null || val === undefined || isNaN(val)) return '0';
    return Number(parseFloat(val).toFixed(8)).toString();
}

function fmtUSD(val) {
    if (val === null || val === undefined || isNaN(val)) return '$0.00';
    return '$' + parseFloat(val).toFixed(2);
}

function fmtPnL(val) {
    if (val === null || val === undefined || isNaN(val)) return '0.00';
    return parseFloat(val).toFixed(2);
}

// Selected orders table
async function updateSelectedOrders() {
    const container = document.getElementById('selectedOrdersContainer');
    if (!container) return console.error('selectedOrdersContainer not found');

    // Собираем информацию о существующих таблицах
    const existingTables = new Map();
    container.querySelectorAll('.coin-group').forEach(table => {
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
        container.innerHTML = '<div class="text-center text-gray-500 mt-4" style="color: #888;">No orders selected</div>';
        return;
    }

    const sortedPairs = Array.from(ordersByCoin.keys()).sort();
    for (const pair of sortedPairs) {
        const orders = ordersByCoin.get(pair).sort((a, b) => new Date(b.created_time) - new Date(a.created_time));
        let tableContainer = existingTables.get(pair);
        const isNewTable = !tableContainer;

        if (isNewTable) {
            tableContainer = document.createElement('div');
            tableContainer.className = 'coin-group';
        }

        const coin = pair.split('-')[0];

        // Calculate totals
        const totalFilled = orders.reduce((sum, order) => {
            const filledSize = parseFloat(order.filled_size) || 0;
            return sum + (order.side.toLowerCase() === 'buy' ? filledSize : -filledSize);
        }, 0);

        const totalUSD = orders.reduce((sum, order) => {
            const totalValue = parseFloat(order.total_value) || 0;
            return sum + (order.side.toLowerCase() === 'sell' ? -totalValue : totalValue);
        }, 0);

        // Calculate average buy price
        const buyOrders = orders.filter(o => o.side.toLowerCase() === 'buy');
        const totalBuyValue = buyOrders.reduce((sum, o) => sum + (parseFloat(o.total_value) || 0), 0);
        const totalBuyFilled = buyOrders.reduce((sum, o) => sum + (parseFloat(o.filled_size) || 0), 0);
        const avgBuyPrice = totalBuyFilled > 0 ? totalBuyValue / totalBuyFilled : 0;

        // Get current prices
        let bestBid = 0, bestAsk = 0;
        try {
            const tickerData = await (await fetch(`https://api.exchange.coinbase.com/products/${pair}/ticker`)).json();
            bestBid = parseFloat(tickerData.bid) || 0;
            bestAsk = parseFloat(tickerData.ask) || 0;
        } catch (error) {
            console.error(`Error fetching prices for ${pair}:`, error);
        }

        // Calculate profit/loss
        const limitFee = window.FEES?.PROFIT_LIMIT || 0.0007;
        const marketFee = window.FEES?.PROFIT_MARKET || 0.0016;

        const limitSellValue = totalFilled * bestAsk * (1 - limitFee);
        const initLimitPnL = limitSellValue - totalUSD;

        const marketSellValue = totalFilled * bestBid * (1 - marketFee);
        const initMarketPnL = marketSellValue - totalUSD;
        const initMarketPct = totalUSD > 0 ? (initMarketPnL / totalUSD) * 100 : 0;

        // Get price decimals
        let priceDecimals = 2;
        try {
            if (bestAsk > 0) {
                const decimalPart = bestAsk.toFixed(10).split('.')[1];
                priceDecimals = decimalPart ? decimalPart.replace(/0+$/, '').length : 2;
            }
        } catch (e) {}

        // Build HTML
        let h = `
          <h4><a href="https://www.tradingview.com/chart/?symbol=COINBASE%3A${coin}USD" target="_blank">${pair}</a></h4>
          <div class="balance" data-pair="${pair}">Balance: ${fmtSize(totalFilled)} ${coin} (avail: ${fmtSize(totalFilled)}, hold: 0)</div>

          <table class="profit-table" data-pair="${pair}" data-filled="${totalFilled}" data-usd="${totalUSD}" data-avgbuy="${avgBuyPrice}">
            <thead><tr><th>Num</th><th>Best Bid</th><th>Best Ask</th><th>Filled Size</th><th>USD</th><th>Avg Buy</th><th>Limit</th><th>Market</th></tr></thead>
            <tbody><tr>
              <td>${orders.length}</td>
              <td id="bid_${coin}">$${fmtPrice(bestBid)}</td>
              <td id="ask_${coin}">$${fmtPrice(bestAsk)}</td>
              <td>${fmtSize(totalFilled)}</td>
              <td>${fmtUSD(totalUSD)}</td>
              <td>$${fmtPrice(avgBuyPrice)}</td>
              <td id="limitpnl_${coin}" class="${initLimitPnL >= 0 ? 'profit-pos' : 'profit-neg'}">${initLimitPnL >= 0 ? '+' : ''}${fmtPnL(initLimitPnL)}</td>
              <td id="pnl_${coin}" class="${initMarketPnL >= 0 ? 'profit-pos' : 'profit-neg'}">${initMarketPnL >= 0 ? '+' : ''}${fmtPnL(initMarketPnL)} (${initMarketPct >= 0 ? '+' : ''}${fmtPnL(initMarketPct)}%)</td>
            </tr></tbody>
          </table>

          <table class="selected-table">
            <thead><tr><th>Order ID</th><th>Side</th><th>Filled</th><th>Limit</th><th>USD</th><th>Done</th><th></th></tr></thead>
            <tbody>`; // sell/ask buttons added below per row

        // Add order rows
        orders.forEach(order => {
            const executedPrice = parseFloat(order.average_filled_price) || 0;
            const filledSize = parseFloat(order.filled_size) || 0;
            const orderValue = parseFloat(order.total_value) || 0;
            const completion = order.completion_percentage || 0;

            const copyData = [
                order.order_id, order.product_id, order.side.toLowerCase(),
                fmtSize(order.order_size), fmtPrice(executedPrice),
                fmtSize(filledSize), orderValue.toFixed(2), order.status.toLowerCase()
            ].join(';').replace(/'/g, "\\'");

            const oid = order.order_id;
            const opair = order.product_id; // e.g. "SUI-USD"
            const ocoin = opair.split('-')[0];
            const osize = fmtSize(filledSize);
            h += `
              <tr data-order-id="${oid}" class="${order.status === 'OPEN' ? 'selected-orders-open' : ''}">
                <td>${oid.split('-')[0]}-...</td>
                <td class="${order.side.toLowerCase() === 'buy' ? 'side-buy' : 'side-sell'}">${order.side.toLowerCase()}</td>
                <td>${osize}</td>
                <td>$${fmtPrice(executedPrice)}</td>
                <td>${fmtUSD(orderValue)}</td>
                <td>${completion}%</td>
                <td style="white-space:nowrap">
                  <button class="copy-btn" onclick="copyOrderToClipboard('${copyData}', this)">Copy</button>
                  <button class="sell-bid-btn" style="background:#ef4444;color:#fff;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;margin-left:2px" onclick="quickSellAtBid('${ocoin}','${osize}')">Sell</button>
                  <button class="sell-ask-btn" style="background:#f97316;color:#fff;border:none;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;margin-left:2px" onclick="quickSellAtAsk('${ocoin}','${osize}')">Ask</button>
                </td>
              </tr>`;
        });

        h += `</tbody></table>`;

        tableContainer.innerHTML = h;

        if (isNewTable) {
            container.appendChild(tableContainer);
        }

        // Update balance
        try {
            const balanceData = await (await fetch(`/get-coin-balance/${coin}`)).json();
            const balanceElement = tableContainer.querySelector(`.balance[data-pair="${pair}"]`);
            if (balanceElement && balanceData.success) {
                const avail = balanceData.balance ?? '0';
                const hold = balanceData.hold ?? '0';
                const total = balanceData.total ?? avail;
                balanceElement.innerHTML = `Balance: ${total} ${coin} (avail: ${avail}, hold: ${hold})`;
            }
        } catch (error) {
            console.error(`Error loading balance for ${pair}:`, error);
        }
    }

    // Update price changes and other UI
    setTimeout(() => {
        if (typeof updatePriceChanges === 'function') updatePriceChanges();
    }, 1000);
    if (typeof updateSellFixedAskPrice === 'function') updateSellFixedAskPrice();
    if (typeof reinitializeAlerts === 'function') reinitializeAlerts();
    if (typeof highlightSelectedCoinTitle === 'function') highlightSelectedCoinTitle();
}

// Balance updates
async function updateUSDBalance() {
    try {
        const [usdResp, usdcResp] = await Promise.all([
            fetch('/get-usd-account'),
            fetch('/get-coin-balance/USDC')
        ]);
        const data = await usdResp.json();
        const usdcData = await usdcResp.json();
        const balanceElement = document.getElementById('usdBalance');
        if (!balanceElement) return;

        if (data.success) {
            const availableUSD = parseFloat(data.balance || 0);

            // Показываем available; если он 0 — показываем total (available + hold)
            const availableUSDC = parseFloat(usdcData?.balance ?? '0') || 0;
            const holdUSDC = parseFloat(usdcData?.hold ?? '0') || 0;
            const totalUSDC = parseFloat(usdcData?.total ?? (availableUSDC + holdUSDC)) || (availableUSDC + holdUSDC);
            const usdcShown = availableUSDC > 0 ? availableUSDC : totalUSDC;

            balanceElement.innerHTML = `
                <div class="font-bold">USD Balance: $${availableUSD.toFixed(2)}</div>
                <div class="font-bold">USDC: ${String(usdcShown)}</div>
            `;
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
        const fixedAskCells = document.querySelectorAll(`.best-ask-fixed-cell[data-pair="${pair}"]`);
        const profitCells = document.querySelectorAll(`.profit-cell[data-pair="${pair}"]`);
        const profitMarketCells = document.querySelectorAll(`.profit-market-cell[data-pair="${pair}"]`);
        const profitFixedCells = document.querySelectorAll(`.profit-fixed-cell[data-pair="${pair}"]`);
        const fixedAskVsFirstCells = document.querySelectorAll(`.fixed-ask-vs-first-cell[data-pair="${pair}"]`);

        const bidPrice = parseFloat(data.bid);
        const askPrice = parseFloat(data.ask);

        if (isNaN(bidPrice) || isNaN(askPrice)) throw new Error('Invalid price format');

        // Проверяем все активные уведомления после обновления цен
        checkAllPriceAlerts();

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

        // Зафиксировать Best Ask при первом апдейте и далее показывать сохранённое значение
        if (!fixedBestAskByPair.has(pair)) {
            fixedBestAskByPair.set(pair, `$${data.ask}`);
        }
        fixedAskCells.forEach(cell => {
            cell.textContent = fixedBestAskByPair.get(pair);
            cell.classList.remove('error', 'created-order-highlight');
        });

        // Пересчитать Fixed Profit после обновления фиксированной цены
        updateFixedProfitForPair(pair);
        // NEW: синхронизировать форму Sell с актуальными значениями из таблицы
        updateSellFixedAskPrice();

        // Пересчёт Limit profit (по текущему ask)
        profitCells.forEach(cell => {
            const row = cell.closest('tr');
            const sizeEl = row?.querySelector('.summary-filled-size') || row?.querySelector('td:nth-child(5)');
            const usdEl = row?.querySelector('.summary-total-usd') || row?.querySelector('td:nth-child(6)');
            const totalFilledSize = parseFloat(sizeEl?.textContent || '');
            const totalValue = parseFloat(usdEl?.textContent || '');

            if (!isNaN(totalFilledSize) && !isNaN(totalValue) && !isNaN(askPrice)) {
                const potentialValue = askPrice * totalFilledSize;
                const afterFees = potentialValue * (1 - window.FEES.PROFIT_LIMIT);
                const profit = afterFees - totalValue;
                const profitFormatted = profit.toFixed(2);
                cell.textContent = profitFormatted;
                cell.classList.remove('positive', 'negative', 'error');
                if (profit > 0) {
                    cell.classList.add('positive');
                } else if (profit < 0) {
                    cell.classList.add('negative');
                }
            } else {
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });

        // NEW: пересчёт “Fixed vs Buy %” вместе с Limit
        const firstExecutedText = document.querySelector(`.first-executed-price[data-pair="${pair}"]`)?.textContent || '';
        const firstExecutedPrice = parseFloat(String(firstExecutedText).replace(/[^0-9.]/g, ''));
        const fixedAskText =
            fixedBestAskByPair.get(pair) ||
            document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`)?.textContent ||
            '';
        const fixedAskPrice = parseFloat(String(fixedAskText).replace(/[^0-9.]/g, ''));

        fixedAskVsFirstCells.forEach(cell => {
            if (Number.isFinite(fixedAskPrice) && Number.isFinite(firstExecutedPrice) && firstExecutedPrice !== 0) {
                const diffPercent = ((fixedAskPrice - firstExecutedPrice) / firstExecutedPrice) * 100;
                const formatted = `${diffPercent >= 0 ? '+' : ''}${diffPercent.toFixed(2)}%`;
                cell.textContent = formatted;
                cell.classList.remove('positive', 'negative', 'error');
                if (diffPercent > 0) {
                    cell.classList.add('positive');
                } else if (diffPercent < 0) {
                    cell.classList.add('negative');
                }
            } else {
                cell.textContent = 'Error';
                cell.classList.remove('positive', 'negative');
                cell.classList.add('error');
            }
        });

        // Пересчёт Market profit
        profitMarketCells.forEach(async cell => {
            const row = cell.closest('tr');
            const sizeEl = row?.querySelector('.summary-filled-size') || row?.querySelector('td:nth-child(5)');
            const usdEl = row?.querySelector('.summary-total-usd') || row?.querySelector('td:nth-child(6)');
            const totalFilledSize = parseFloat(sizeEl?.textContent || '');
            const totalValue = parseFloat(usdEl?.textContent || '');
            const limitProfitCell = row.querySelector('.profit-cell');
            const limitProfit = parseFloat(limitProfitCell?.textContent || 0);

            if (!isNaN(totalFilledSize) && !isNaN(totalValue)) {
                const marketProfit = await calculateMarketProfit(pair, totalFilledSize, totalValue);

                if (marketProfit !== null) {
                    const difference = (parseFloat(marketProfit) - limitProfit).toFixed(2);
                    const differenceHtml = `
                        <span class="profit-difference ${difference < 0 ? 'negative' : 'positive'}">(${difference})</span>
                    `;
                    cell.innerHTML = `${marketProfit}${differenceHtml}`;
                    cell.classList.remove('error', 'positive', 'negative');
                    if (parseFloat(marketProfit) > 0) {
                        cell.classList.add('positive');
                    } else if (parseFloat(marketProfit) < 0) {
                        cell.classList.add('negative');
                    }
                } else {
                    cell.textContent = 'Error';
                    cell.classList.add('error');
                }
            } else {
                cell.textContent = 'Error';
                cell.classList.add('error');
            }
        });
    } catch (error) {
        console.error(`Error updating prices for ${pair}:`, error);
        const cells = [
            ...document.querySelectorAll(`.best-bid-cell[data-pair="${pair}"]`),
            ...document.querySelectorAll(`.best-ask-cell[data-pair="${pair}"]`),
            ...document.querySelectorAll(`.best-ask-fixed-cell[data-pair="${pair}"]`),
            ...document.querySelectorAll(`.profit-fixed-cell[data-pair="${pair}"]`),
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
            const balanceStr = String(balanceData.balance ?? '0');
            const availableCoin = parseFloat(balanceStr) || 0;
            const percentage = parseInt(document.getElementById('sellPercentageInput').value);

            const pair = getActivePair() || `${coin}-USD`;
            let summaryRow = document.querySelector(`.profit-fixed-cell[data-pair="${pair}"]`)?.closest('tr');
            if (!summaryRow) {
                const fixedCell = document.querySelector(`.best-ask-fixed-cell[data-pair="${pair}"]`);
                summaryRow = fixedCell?.closest('tr') || null;
            }
            const summaryFilledSizeEl = summaryRow?.querySelector('.summary-filled-size');
            const summaryFilledSizeStr = String(summaryFilledSizeEl?.textContent || '0');
            const summaryFilledSize = parseFloat(summaryFilledSizeStr) || 0;

            const baseAmount = availableCoin > 0 ? availableCoin : summaryFilledSize;

            let displayAmount;
            if (percentage === 100) {
                displayAmount = availableCoin > 0 ? balanceStr : summaryFilledSizeStr;
            } else {
                displayAmount = ((baseAmount * percentage) / 100).toString();
            }

            const sellPurchaseAmountElement = document.getElementById('sellPurchaseAmount');
            if (sellPurchaseAmountElement) sellPurchaseAmountElement.textContent = displayAmount;
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
        const response = await fetch(`/get-product-info/${coin}`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`📊 getProductInfo: Получен ответ от API:`, data);

        if (!data.success) {
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
            highlightSelectedCoinTitle();
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
                const createdTimeText = cells[10].textContent.replace(/\s+/g, ' ').trim(); // Скрытая колонка с временем
                
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

// Функция для отправки сообщения в Telegram
window.sendTelegramMessage = async (orderId) => {
    try {
        // Находим ордер в currentOrders Map
        const order = currentOrders.get(orderId);
        if (!order) {
            showCustomAlert('Ордер не найден', true);
            return;
        }

        const symbol = order.product_id; // например "AVNT-USD"
        const targetPrice = parseFloat(order.limit_price || order.average_filled_price || 0);
        
        if (!targetPrice || isNaN(targetPrice)) {
            showCustomAlert('Не удалось определить цену для уведомления', true);
            return;
        }

        // Очищаем дубликаты перед проверкой
        removeDuplicateAlerts();
        
        // Проверяем, есть ли уже уведомление для этого ордера
        const existingAlerts = getAllPriceAlerts();
        const alertExists = Object.values(existingAlerts).some(alert => alert.orderId === orderId);
        
        // Находим кнопку Telegram для этого ордера
        const telegramButton = document.querySelector(`button[onclick="sendTelegramMessage('${orderId}')"]`);
        
        if (alertExists) {
            // Удаляем существующее уведомление
            Object.keys(existingAlerts).forEach(alertId => {
                if (existingAlerts[alertId].orderId === orderId) {
                    removePriceAlert(alertId);
                }
            });
            showCustomAlert(`❌ Ценовое уведомление отменено для ${symbol}`, false);
            
            // Обновляем внешний вид кнопки - отключено
            if (telegramButton) {
                telegramButton.textContent = 'Telegram';
                telegramButton.className = 'telegram-btn bg-gray-500 hover:bg-gray-600 text-white font-bold py-1 px-2 rounded border-2 border-gray-400';
                telegramButton.style.cssText = `
                    background: linear-gradient(135deg, #6b7280, #4b5563);
                    border: 2px solid #9ca3af;
                    color: white;
                    font-weight: bold;
                    padding: 4px 8px;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    box-shadow: none;
                `;
            }
        } else {
            // Создаем новое ценовое уведомление
            const alertId = savePriceAlert(symbol, targetPrice, orderId);
            showCustomAlert(`🔔 Ценовое уведомление установлено для ${symbol} по цене $${targetPrice}`, false);
            console.log(`Price alert created with ID: ${alertId} for order: ${orderId}`);
            
            // Обновляем внешний вид кнопки - включено
            if (telegramButton) {
                telegramButton.textContent = '🔔 Alert ON';
                telegramButton.className = 'telegram-btn bg-green-500 hover:bg-green-600 text-white font-bold py-1 px-2 rounded border-2 border-green-300';
                telegramButton.style.cssText = `
                    background: linear-gradient(135deg, #10b981, #059669);
                    border: 2px solid #34d399;
                    color: white;
                    font-weight: bold;
                    padding: 4px 8px;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
                    animation: pulse-green 2s infinite;
                `;
            }
        }
        
        // Обновляем визуальные индикаторы для всех строк
        updateAllRowStatuses();
        
    } catch (error) {
        console.error('Ошибка установки ценового уведомления:', error);
        showCustomAlert('Ошибка установки ценового уведомления', true);
    }
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

// Copy Best Ask function - исправлена для правильного копирования цены
async function copyBestAsk(pair) {
    try {
        // Оригинальная логика для копирования цены
        const askCell = document.querySelector(`.best-ask-cell[data-pair="${pair}"]`);
        if (!askCell) {
            console.error('Ask cell not found for pair:', pair);
            return;
        }
        
        const askPrice = askCell.textContent;
        console.log('Copying price:', askPrice);
        
        if (askPrice && askPrice !== 'Loading...' && askPrice !== 'Error loading price') {
            // Извлекаем только числовое значение цены
            const numericPrice = askPrice.replace(/[^0-9.]/g, '');
            console.log('Numeric price:', numericPrice);
            
            if (numericPrice && !isNaN(parseFloat(numericPrice))) {
                await navigator.clipboard.writeText(numericPrice);
                showCustomAlert('Price copied!');
            } else {
                console.error('Invalid price format:', askPrice);
                showCustomAlert('Invalid price format', true);
            }
        } else {
            console.error('Price not available:', askPrice);
            showCustomAlert('Price not available', true);
        }
    } catch (error) {
        console.error('Error copying price:', error);
        showCustomAlert('Failed to copy price', true);
    }
}

// Make copyBestAsk available globally
window.copyBestAsk = copyBestAsk;

// Quick sell at current Bid price (Sell button near each order)
window.quickSellAtBid = async function(coin, sizeStr) {
    try {
        const ticker = await (await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`)).json();
        if (!ticker.bid) throw new Error('Could not get bid price');
        // Use raw string from API — avoids scientific notation for tiny prices
        const bidStr = ticker.bid;
        showCustomAlert(`Sell order at Bid! ${coin}-USD @ $${bidStr}`, false);
        const result = await (await fetch('/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coin, baseSize: sizeStr, limitPrice: bidStr, side: 'SELL' })
        })).json();
        if (result.success) {
            showCustomAlert(`✅ Sold ${sizeStr} ${coin} @ $${bidStr}`, false);
            await loadLatestOrders();
        } else {
            showCustomAlert(`❌ Sell failed: ${result.error}`, true);
        }
    } catch (e) {
        showCustomAlert(`❌ Error: ${e.message}`, true);
    }
};

// Quick sell at current Ask price (Ask button near each order)
window.quickSellAtAsk = async function(coin, sizeStr) {
    try {
        const ticker = await (await fetch(`https://api.exchange.coinbase.com/products/${coin}-USD/ticker`)).json();
        if (!ticker.ask) throw new Error('Could not get ask price');
        // Use raw string from API — avoids scientific notation for tiny prices
        const askStr = ticker.ask;
        showCustomAlert(`Sell order at Ask! ${coin}-USD @ $${askStr}`, false);
        const result = await (await fetch('/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ coin, baseSize: sizeStr, limitPrice: askStr, side: 'SELL' })
        })).json();
        if (result.success) {
            showCustomAlert(`✅ Sold ${sizeStr} ${coin} @ $${askStr}`, false);
            await loadLatestOrders();
        } else {
            showCustomAlert(`❌ Sell failed: ${result.error}`, true);
        }
    } catch (e) {
        showCustomAlert(`❌ Error: ${e.message}`, true);
    }
};

// Make createOrderFromCurrentData available globally
window.createOrderFromCurrentData = createOrderFromCurrentData;

// Обработчик callback'ов от Telegram
async function handleTelegramCallback(callbackQuery) {
    const botToken = '8424757901:AAE6SIdQdbWrWU3XHn5xZbOxMSSp1kc24eQ';
    const { id, message, data } = callbackQuery;
    
    if (data === 'delete_message') {
        try {
            // Удаляем сообщение
            const deleteResponse = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    chat_id: message.chat.id,
                    message_id: message.message_id
                })
            });
            
            const deleteResult = await deleteResponse.json();
            
            if (deleteResult.ok) {
                console.log('✅ Message deleted successfully');
                
                // Отвечаем на callback, чтобы убрать "loading" с кнопки
                await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        callback_query_id: id,
                        text: 'Сообщение удалено ✅'
                    })
                });
            } else {
                console.error('❌ Failed to delete message:', deleteResult);
                
                // Отвечаем на callback с ошибкой
                await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        callback_query_id: id,
                        text: 'Ошибка удаления сообщения ❌',
                        show_alert: true
                    })
                });
            }
        } catch (error) {
            console.error('❌ Error handling callback:', error);
            
            // Отвечаем на callback с ошибкой
            await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    callback_query_id: id,
                    text: 'Произошла ошибка ❌',
                    show_alert: true
                })
            });
        }
    }
}

// Универсальные функции для работы с уведомлениями по ценам
function savePriceAlert(symbol, targetPrice, orderId = null) {
    const alerts = getAllPriceAlerts();
    
    // Проверяем, есть ли уже уведомление для этого ордера
    if (orderId) {
        const existingAlert = Object.values(alerts).find(alert => alert.orderId === orderId);
        if (existingAlert) {
            console.log(`Price alert already exists for order ${orderId}`);
            return Object.keys(alerts).find(key => alerts[key].orderId === orderId);
        }
    }
    
    const alertId = orderId || `${symbol}_${Date.now()}`;
    
    alerts[alertId] = {
        symbol: symbol,
        targetPrice: parseFloat(targetPrice),
        timestamp: Date.now(),
        orderId: orderId
    };
    
    localStorage.setItem('priceAlerts', JSON.stringify(alerts));
    console.log(`Price alert set for ${symbol} at $${targetPrice} (ID: ${alertId})`);
    console.log('All alerts after save:', alerts);
    return alertId;
}

function getAllPriceAlerts() {
    const alerts = localStorage.getItem('priceAlerts');
    return alerts ? JSON.parse(alerts) : {};
}

function getPriceAlertsForSymbol(symbol) {
    const allAlerts = getAllPriceAlerts();
    const symbolAlerts = {};
    
    Object.keys(allAlerts).forEach(alertId => {
        if (allAlerts[alertId].symbol === symbol) {
            symbolAlerts[alertId] = allAlerts[alertId];
        }
    });
    
    return symbolAlerts;
}

function removePriceAlert(alertId) {
    const alerts = getAllPriceAlerts();
    if (alerts[alertId]) {
        const symbol = alerts[alertId].symbol;
        delete alerts[alertId];
        localStorage.setItem('priceAlerts', JSON.stringify(alerts));
        console.log(`Price alert removed for ${symbol} (ID: ${alertId})`);
        return true;
    }
    return false;
}

function clearAllAlertsForSymbol(symbol) {
    const alerts = getAllPriceAlerts();
    let removedCount = 0;
    
    Object.keys(alerts).forEach(alertId => {
        if (alerts[alertId].symbol === symbol) {
            delete alerts[alertId];
            removedCount++;
        }
    });
    
    localStorage.setItem('priceAlerts', JSON.stringify(alerts));
    console.log(`Removed ${removedCount} alerts for ${symbol}`);
    return removedCount;
}

// Новая функция для очистки дубликатов по orderId
function removeDuplicateAlerts() {
    const alerts = getAllPriceAlerts();
    const seenOrderIds = new Set();
    const alertsToKeep = {};
    let duplicatesRemoved = 0;
    
    Object.keys(alerts).forEach(alertId => {
        const alert = alerts[alertId];
        if (alert.orderId) {
            if (!seenOrderIds.has(alert.orderId)) {
                seenOrderIds.add(alert.orderId);
                alertsToKeep[alertId] = alert;
            } else {
                duplicatesRemoved++;
                console.log(`Removing duplicate alert for order ${alert.orderId}`);
            }
        } else {
            alertsToKeep[alertId] = alert;
        }
    });
    
    localStorage.setItem('priceAlerts', JSON.stringify(alertsToKeep));
    console.log(`Removed ${duplicatesRemoved} duplicate alerts`);
    return duplicatesRemoved;
}

// Функция отправки уведомления в Telegram
function sendTelegramPriceAlert(symbol, currentPrice, targetPrice, orderId = null) {
    const botToken = '8424757901:AAE6SIdQdbWrWU3XHn5xZbOxMSSp1kc24eQ';
    const chatId = 1813047875;
    const orderInfo = orderId ? `\nOrder ID: ${orderId}` : '';
    const message = `🚨 Price Alert!\n\nSymbol: ${symbol}\nCurrent Price: $${currentPrice}\n-------\n🎯 **Target Price: $${targetPrice}\n-------\n**${orderInfo}\n\nPrice target reached!`;
    
    console.log('Sending Telegram message:', message);
    
    // Деактивируем кнопку сразу после отправки
    let telegramButton = null;
    if (orderId) {
        telegramButton = document.querySelector(`button[onclick="sendTelegramMessage('${orderId}')"]`);
        if (telegramButton) {
            telegramButton.disabled = true;
            telegramButton.textContent = '✅ Sent';
            telegramButton.className = 'telegram-btn bg-gray-400 text-white font-bold py-1 px-2 rounded border-2 border-gray-300 cursor-not-allowed';
            telegramButton.style.cssText = `
                background: linear-gradient(135deg, #9ca3af, #6b7280);
                border: 2px solid #d1d5db;
                color: white;
                font-weight: bold;
                padding: 4px 8px;
                border-radius: 6px;
                cursor: not-allowed;
                opacity: 0.7;
                box-shadow: none;
            `;
        }
    }
    
    return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        })
    })
    .then(response => {
        console.log('Telegram API response status:', response.status);
        return response.json();
    })
    .then(data => {
        if (data.ok) {
            console.log('✅ Price alert sent to Telegram successfully:', data);
            showCustomAlert('Telegram уведомление отправлено!', false);
            
            // Восстанавливаем кнопку через 3 секунды после успешной отправки
            if (telegramButton) {
                setTimeout(() => {
                    telegramButton.disabled = false;
                    telegramButton.textContent = 'Telegram';
                    telegramButton.className = 'telegram-btn bg-blue-500 hover:bg-blue-600 text-white font-bold py-1 px-2 rounded border-2 border-blue-300';
                    telegramButton.style.cssText = '';
                }, 3000);
            }
        } else {
            console.error('❌ Failed to send price alert to Telegram:', data);
            showCustomAlert('Ошибка отправки в Telegram: ' + (data.description || 'Unknown error'), true);
            
            // Если ошибка, возвращаем кнопку в активное состояние немедленно
            if (telegramButton) {
                telegramButton.disabled = false;
                telegramButton.textContent = 'Telegram';
                telegramButton.className = 'telegram-btn bg-blue-500 hover:bg-blue-600 text-white font-bold py-1 px-2 rounded border-2 border-blue-300';
                telegramButton.style.cssText = '';
            }
        }
        return data;
    })
    .catch(error => {
        console.error('❌ Error sending price alert to Telegram:', error);
        showCustomAlert('Ошибка сети при отправке в Telegram: ' + error.message, true);
        
        // Если ошибка, возвращаем кнопку в активное состояние немедленно
        if (telegramButton) {
            telegramButton.disabled = false;
            telegramButton.textContent = 'Telegram';
            telegramButton.className = 'telegram-btn bg-blue-500 hover:bg-blue-600 text-white font-bold py-1 px-2 rounded border-2 border-blue-300';
            telegramButton.style.cssText = '';
        }
        throw error;
    });
}

// Универсальная функция для установки уведомления из таблицы ордеров
function setPriceAlertFromRow(rowElement) {
    try {
        // Извлекаем данные из строки таблицы
        const cells = rowElement.querySelectorAll('td');
        if (cells.length < 4) {
            console.error('Invalid row structure');
            return;
        }
        
        // Определяем символ из первой ячейки или заголовка страницы
        let symbol = 'UNKNOWN';
        
        // Попробуем найти символ в строке ордера
        const orderIdCell = cells[1]; // Предполагаем, что ID ордера во второй ячейке
        if (orderIdCell && orderIdCell.textContent.includes('(') && orderIdCell.textContent.includes(')')) {
            const match = orderIdCell.textContent.match(/\(([A-Z]+-[A-Z]+)\)/);
            if (match) {
                symbol = match[1];
            }
        }
        
        // Если не нашли в ордере, ищем в заголовке страницы
        if (symbol === 'UNKNOWN') {
            const pageTitle = document.querySelector('h1, .symbol, .pair-name, title');
            if (pageTitle) {
                const titleMatch = pageTitle.textContent.match(/([A-Z]+-[A-Z]+)/);
                if (titleMatch) {
                    symbol = titleMatch[1];
                }
            }
        }
        
        // Извлекаем Best Ask цену (предполагаем, что она в 3-й ячейке)
        const bestAskCell = cells[2];
        if (!bestAskCell) {
            console.error('Best Ask cell not found');
            return;
        }
        
        const bestAskPrice = bestAskCell.textContent.replace('$', '').trim();
        const targetPrice = parseFloat(bestAskPrice);
        
        if (isNaN(targetPrice)) {
            console.error('Invalid price format:', bestAskPrice);
            return;
        }
        
        // Извлекаем ID ордера для уникальности
        let orderId = null;
        if (orderIdCell) {
            const orderIdMatch = orderIdCell.textContent.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
            if (orderIdMatch) {
                orderId = orderIdMatch[1];
            }
        }
        
        // Проверяем, есть ли уже уведомление для этого ордера
        const alertId = orderId || `${symbol}_${targetPrice}_${Date.now()}`;
        const existingAlerts = getAllPriceAlerts();
        
        if (existingAlerts[alertId]) {
            // Удаляем существующее уведомление
            removePriceAlert(alertId);
            showCustomAlert(`Price alert cancelled for ${symbol}`, false);
            updateRowAlertStatus(rowElement, false);
        } else {
            // Создаем новое уведомление
            savePriceAlert(symbol, targetPrice, orderId);
            showCustomAlert(`Price alert set for ${symbol} at $${targetPrice}`, false);
            updateRowAlertStatus(rowElement, true);
        }
        
    } catch (error) {
        console.error('Error setting price alert:', error);
        showCustomAlert('Error setting price alert', true);
    }
}

// Улучшенная функция обновления статуса строки
function updateRowAlertStatus(rowElement, hasAlert) {
    const telegramButton = rowElement.querySelector('button[onclick*="sendTelegramMessage"]');
    if (telegramButton) {
        if (hasAlert) {
            // Активное уведомление - зеленый с пульсацией
            telegramButton.textContent = '🔔 Alert ON';
            telegramButton.className = 'telegram-btn bg-green-500 hover:bg-green-600 text-white font-bold py-1 px-2 rounded border-2 border-green-300';
            telegramButton.style.cssText = `
                background: linear-gradient(135deg, #10b981, #059669);
                border: 2px solid #34d399;
                color: white;
                font-weight: bold;
                padding: 4px 8px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: 0 0 10px rgba(16, 185, 129, 0.4);
                animation: pulse-green 2s infinite;
            `;
            // Подсветка строки
            rowElement.style.backgroundColor = '#f0fdf4'; // Светло-зеленый фон
            rowElement.style.borderLeft = '4px solid #10b981';
        } else {
            // Неактивное уведомление - серый
            telegramButton.textContent = 'Telegram';
            telegramButton.className = 'telegram-btn bg-gray-500 hover:bg-gray-600 text-white font-bold py-1 px-2 rounded border-2 border-gray-400';
            telegramButton.style.cssText = `
                background: linear-gradient(135deg, #6b7280, #4b5563);
                border: 2px solid #9ca3af;
                color: white;
                font-weight: bold;
                padding: 4px 8px;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.3s ease;
                box-shadow: none;
            `;
            // Убираем подсветку строки
            rowElement.style.backgroundColor = '';
            rowElement.style.borderLeft = '';
        }
    }
}

// Универсальная функция проверки всех уведомлений
function checkAllPriceAlerts() {
    const allAlerts = getAllPriceAlerts();
    const currentPrices = getCurrentPrices();
    
    console.log('Checking price alerts:', {
        alertsCount: Object.keys(allAlerts).length,
        alerts: allAlerts,
        currentPrices: currentPrices
    });
    
    Object.keys(allAlerts).forEach(alertId => {
        const alert = allAlerts[alertId];
        const currentPrice = currentPrices[alert.symbol];
        
        console.log(`Alert ${alertId}: ${alert.symbol} - Target: $${alert.targetPrice}, Current: $${currentPrice}`);
        
        if (currentPrice && currentPrice >= alert.targetPrice) {
            console.log(`🚨 ALERT TRIGGERED! ${alert.symbol}: $${currentPrice} >= $${alert.targetPrice}`);
            
            // Отправляем уведомление
            sendTelegramPriceAlert(alert.symbol, currentPrice, alert.targetPrice, alert.orderId);
            
            // Удаляем уведомление после срабатывания
            removePriceAlert(alertId);
            
            // Обновляем интерфейс
            updateAllRowStatuses();
            
            // Показываем локальное уведомление
            showCustomAlert(`Price alert triggered! ${alert.symbol} reached $${currentPrice}`, false);
        } else if (!currentPrice) {
            console.warn(`No current price found for symbol: ${alert.symbol}`);
        }
    });
}

// Функция для получения текущих цен всех символов из таблицы
function getCurrentPrices() {
    const prices = {};
    
    // Получаем цены из summary таблиц в selected orders
    const summaryTables = document.querySelectorAll('.summary-table');
    summaryTables.forEach(table => {
        const bestAskCell = table.querySelector('.best-ask-cell');
        if (bestAskCell) {
            const pair = bestAskCell.getAttribute('data-pair');
            const priceText = bestAskCell.textContent.replace('$', '').trim();
            const price = parseFloat(priceText);
            
            if (pair && !isNaN(price) && priceText !== 'Loading...' && priceText !== 'Error') {
                prices[pair] = price;
                console.log(`Price found for ${pair}: $${price}`);
            }
        }
    });
    
    // Fallback: получаем цены из основной таблицы
    if (Object.keys(prices).length === 0) {
        const rows = document.querySelectorAll('table tr');
        
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 3) {
                // Извлекаем символ
                let symbol = 'UNKNOWN';
                const orderIdCell = cells[1];
                if (orderIdCell && orderIdCell.textContent.includes('(') && orderIdCell.textContent.includes(')')) {
                    const match = orderIdCell.textContent.match(/\(([A-Z]+-[A-Z]+)\)/);
                    if (match) {
                        symbol = match[1];
                    }
                }
                
                // Извлекаем цену Best Ask
                const bestAskCell = cells[2].querySelector('.best-ask-cell') || cells[2];
                if (bestAskCell && symbol !== 'UNKNOWN') {
                    const priceText = bestAskCell.textContent.replace('$', '').trim();
                    const price = parseFloat(priceText);
                    if (!isNaN(price)) {
                        prices[symbol] = price;
                        console.log(`Price found for ${symbol}: $${price}`);
                    }
                }
            }
        });
    }
    
    console.log('Current prices:', prices);
    return prices;
}

// Функция для обновления статуса всех строк
function updateAllRowStatuses() {
    const allAlerts = getAllPriceAlerts();
    const rows = document.querySelectorAll('#ordersTableBody tr');
    
    console.log('Updating row statuses for', rows.length, 'rows');
    console.log('Active alerts:', Object.keys(allAlerts));
    
    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
            const orderIdCell = cells[1];
            if (orderIdCell) {
                const orderIdMatch = orderIdCell.textContent.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
                if (orderIdMatch) {
                    const orderId = orderIdMatch[1];
                    // Проверяем наличие алерта по orderId в значениях объекта allAlerts
                    const hasAlert = Object.values(allAlerts).some(alert => alert.orderId === orderId);
                    console.log(`Order ${orderId}: hasAlert = ${hasAlert}`);
                    updateRowAlertStatus(row, hasAlert);
                }
            }
        }
    });
}

// Функция инициализации при загрузке страницы
function initializePriceAlerts() {
    // Обновляем статус всех строк при загрузке
    updateAllRowStatuses();
    
    // Показываем количество активных уведомлений
    const allAlerts = getAllPriceAlerts();
    const alertCount = Object.keys(allAlerts).length;
    if (alertCount > 0) {
        console.log(`Found ${alertCount} active price alerts`);
        showCustomAlert(`${alertCount} active price alerts loaded`, false);
    }
}

// Добавляем обработчики событий для всех кнопок Copy
function attachAlertHandlers() {
    // НЕ трогаем кнопки Copy Ask - они должны копировать цену
    // Если нужны уведомления, создайте отдельные кнопки для этого
    console.log('Copy Ask buttons left unchanged for price copying functionality');
}

// Переинициализация при обновлении таблицы
function reinitializeAlerts() {
    attachAlertHandlers();
    updateAllRowStatuses();
}

// Добавляем отладочную информацию после определения функции
console.log('✅ Функция createOrderFromCurrentData определена:', typeof createOrderFromCurrentData);

// Также добавьте глобальную привязку для отладки:
window.createOrderFromCurrentData = createOrderFromCurrentData;
console.log('🌐 Функция добавлена в window:', typeof window.createOrderFromCurrentData);

// Глобальные переменные для Telegram polling
window.lastUpdateId = lastUpdateId;
window.pollTelegramUpdates = pollTelegramUpdates;
window.handleTelegramCallback = handleTelegramCallback;

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



// Функция для получения обновлений от Telegram
let lastUpdateId = 0;

async function pollTelegramUpdates() {
    const botToken = '8424757901:AAE6SIdQdbWrWU3XHn5xZbOxMSSp1kc24eQ';
    
    try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
        const data = await response.json();
        
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                
                // Обрабатываем callback'и от inline-кнопок
                if (update.callback_query) {
                    await handleTelegramCallback(update.callback_query);
                }
            }
        }
    } catch (error) {
        console.error('❌ Error polling Telegram updates:', error);
    }
    
    // Повторяем через 3 секунды
    setTimeout(pollTelegramUpdates, 3000);
}

// Handle order creation
window.handleOrderCreated = async response => {
    console.log('Order created response:', response);
    if (response.success) {
        await loadLatestOrders();
        await updateUSDBalance();
    }
};
