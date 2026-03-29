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
exports.createConvertQuote = createConvertQuote;
exports.getConvertTrade = getConvertTrade;
exports.commitConvertTrade = commitConvertTrade;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [POST] Create Convert Quote
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_createconvertquote
function createConvertQuote(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/convert/quote`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Convert Trade
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getconverttrade
function getConvertTrade(_a) {
    var { tradeId } = _a, requestParams = __rest(_a, ["tradeId"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/convert/trade/${tradeId}`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [POST] Commit Connvert Trade
// https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_commitconverttrade
function commitConvertTrade(_a) {
    var { tradeId } = _a, requestParams = __rest(_a, ["tradeId"]);
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/convert/trade/${tradeId}`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
