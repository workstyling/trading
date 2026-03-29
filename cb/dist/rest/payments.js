"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentMethods = listPaymentMethods;
exports.getPaymentMethod = getPaymentMethod;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] List Payment Methods
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpaymentmethods
function listPaymentMethods() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/payment_methods`,
        isPublic: false,
    });
}
// [GET] Get Payment Method
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getpaymentmethod
function getPaymentMethod({ paymentMethodId }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/payment_methods/${paymentMethodId}`,
        isPublic: false,
    });
}
