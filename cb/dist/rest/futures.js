"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFuturesBalanceSummary = getFuturesBalanceSummary;
exports.getIntradayMarginSetting = getIntradayMarginSetting;
exports.setIntradayMarginSetting = setIntradayMarginSetting;
exports.getCurrentMarginWindow = getCurrentMarginWindow;
exports.listFuturesPositions = listFuturesPositions;
exports.getFuturesPosition = getFuturesPosition;
exports.scheduleFuturesSweep = scheduleFuturesSweep;
exports.listFuturesSweeps = listFuturesSweeps;
exports.cancelPendingFuturesSweep = cancelPendingFuturesSweep;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] Get Futures Balance Summary
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getfcmbalancesummary
function getFuturesBalanceSummary() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/cfm/balance_summary`,
        isPublic: false,
    });
}
// [GET] Get Intraday Margin Setting
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getintradaymarginsetting
function getIntradayMarginSetting() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/cfm/intraday/margin_setting`,
        isPublic: false,
    });
}
// [POST] Set Intraday Margin Setting
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_setintradaymarginsetting
function setIntradayMarginSetting(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/cfm/intraday/margin_setting`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Current Margin Window
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getcurrentmarginwindow
function getCurrentMarginWindow(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/cfm/intraday/current_margin_window`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] List Futures Positions
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getfcmpositions
function listFuturesPositions() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/cfm/positions`,
        isPublic: false,
    });
}
// [GET] Get Futures Position
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getfcmposition
function getFuturesPosition({ productId }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/cfm/positions/${productId}`,
        isPublic: false,
    });
}
// [POST] Schedule Futures Sweep
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_schedulefcmsweep
function scheduleFuturesSweep(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/cfm/sweeps/schedule`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [GET] List Futures Sweeps
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getfcmsweeps
function listFuturesSweeps() {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/cfm/sweeps`,
        isPublic: false,
    });
}
// [DELETE] Cancel Pending Futures Sweep
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_cancelfcmsweep
function cancelPendingFuturesSweep() {
    return this.request({
        method: request_types_1.method.DELETE,
        endpoint: `${constants_1.API_PREFIX}/cfm/sweeps`,
        isPublic: false,
    });
}
