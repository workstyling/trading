"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBestBidAsk = getBestBidAsk;
exports.getProductBook = getProductBook;
exports.listProducts = listProducts;
exports.getProduct = getProduct;
exports.getProductCandles = getProductCandles;
exports.getMarketTrades = getMarketTrades;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] Get Best Bid Ask
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getbestbidask
function getBestBidAsk(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/best_bid_ask`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Product Book
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getproductbook
function getProductBook(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/product_book`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] List Products
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getproducts
function listProducts(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/products`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Product
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getproduct
function getProduct(_a) {
    var { productId } = _a, requestParams = __rest(_a, ["productId"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/products/${productId}`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Product Candles
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getcandles
function getProductCandles(_a) {
    var { productId } = _a, requestParams = __rest(_a, ["productId"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/products/${productId}/candles`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Market Trades
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getmarkettrades
function getMarketTrades(_a) {
    var { productId } = _a, requestParams = __rest(_a, ["productId"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/products/${productId}/ticker`,
        queryParams: requestParams,
        isPublic: false,
    });
}
