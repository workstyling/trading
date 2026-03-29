self.onmessage = function (e) {
  console.log('Worker received data:', e.data);
  const orderBook = e.data;

  if (!orderBook.bids || !orderBook.asks) {
    console.error('Invalid orderbook data in worker:', orderBook);
    self.postMessage({ error: 'Invalid orderbook data' });
    return;
  }

  try {
    const processedOrderBook = processOrderBook(orderBook);
    console.log('Worker processed data:', processedOrderBook);
    self.postMessage(processedOrderBook);
  } catch (error) {
    console.error('Error processing orderbook in worker:', error);
    self.postMessage({ error: error.message });
  }
};

function processOrderBook(orderBook) {
  console.log('Processing orderbook:', orderBook);
  const processedAsks = orderBook.asks.slice(0, 15).map(processOrder);
  const processedBids = orderBook.bids.slice(0, 15).map(processOrder);
  console.log('Processed asks:', processedAsks);
  console.log('Processed bids:', processedBids);

  return {
    asks: processedAsks,
    bids: processedBids,
    spread: calculateSpread(processedAsks[0], processedBids[0]),
  };
}

function processOrder(order) {
  if (Array.isArray(order)) {
    return {
      price: parseFloat(order[0]).toFixed(2),
      volume: parseFloat(order[1]).toFixed(8),
      cumulativeVolume: parseFloat(order[2]).toFixed(8),
    };
  }
  return {
    price: parseFloat(order.price).toFixed(2),
    volume: parseFloat(order.volume).toFixed(8),
    cumulativeVolume: parseFloat(order.cumulativeVolume).toFixed(8),
  };
}

function calculateSpread(bestAsk, bestBid) {
  return (parseFloat(bestAsk.price) - parseFloat(bestBid.price)).toFixed(2);
}
