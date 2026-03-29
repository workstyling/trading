"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTransactionSummary = getTransactionSummary;
exports.getFees = getFees;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] Get Transaction Summary
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_commitconverttrade
function getTransactionSummary(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/transaction_summary`,
        queryParams: requestParams,
        isPublic: false,
    });
}

// Добавим новую функцию для получения fees
function getFees() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/fees`,
        isPublic: false,
    });
}
