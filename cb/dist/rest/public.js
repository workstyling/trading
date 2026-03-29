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
exports.getServerTime = getServerTime;
exports.getPublicProductBook = getPublicProductBook;
exports.listPublicProducts = listPublicProducts;
exports.getPublicProduct = getPublicProduct;
exports.getPublicProductCandles = getPublicProductCandles;
exports.getPublicMarketTrades = getPublicMarketTrades;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] Get Server Time
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getservertime
function getServerTime() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/time`,
        isPublic: true,
    });
}
// [GET] Get Public Product Book
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpublicproductbook
function getPublicProductBook(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/market/product_book`,
        queryParams: requestParams,
        isPublic: true,
    });
}
// [GET] List Public Products
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpublicproducts
function listPublicProducts(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/market/products`,
        queryParams: requestParams,
        isPublic: true,
    });
}
// [GET] Get Public Product
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpublicproduct
function getPublicProduct({ productId }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/market/products/${productId}`,
        isPublic: true,
    });
}
// [GET] Get Public Product Candles
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpubliccandles
function getPublicProductCandles(_a) {
    var { productId } = _a, requestParams = __rest(_a, ["productId"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/market/products/${productId}/candles`,
        queryParams: requestParams,
        isPublic: true,
    });
}
// [GET] Get Public Market Trades
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpublicmarkettrades
function getPublicMarketTrades(_a) {
    var { productId } = _a, requestParams = __rest(_a, ["productId"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/products/${productId}/ticker`,
        queryParams: requestParams,
        isPublic: true,
    });
}
