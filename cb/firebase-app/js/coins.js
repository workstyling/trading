const coins = [
    'BTC',
    'ETH',
    'SOL',
    'XRP',
    'ADA',
    'AVAX',
    'DOT',
    'MATIC',
    'LINK',
    'UNI'
];

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { coins };
} else {
    window.coins = coins;
}