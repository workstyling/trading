"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrder = createOrder;
exports.cancelOrders = cancelOrders;
exports.editOrder = editOrder;
exports.editOrderPreview = editOrderPreview;
exports.listOrders = listOrders;
exports.listFills = listFills;
exports.getOrder = getOrder;
exports.previewOrder = previewOrder;
exports.closePosition = closePosition;
exports.createLimitBuyOrder = createLimitBuyOrder;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [POST] Create Order
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_postorder
function createOrder(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [POST] Cancel Orders
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_cancelorders
function cancelOrders(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders/batch_cancel`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [POST] Edit Order
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_editorder
function editOrder(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders/edit`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [POST] Edit Order Preview
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_previeweditorder
function editOrderPreview(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders/edit_preview`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [GET] List Orders
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_gethistoricalorders
function listOrders(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/orders/historical/batch`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] List Fills
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getfills
function listFills(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/orders/historical/fills`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Order
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_gethistoricalorder
function getOrder({ orderId }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/orders/historical/${orderId}`,
        isPublic: false,
    });
}
// [POST] Preview Order
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_previeworder
function previewOrder(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders/preview`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [POST] Close Position
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_closeposition
function closePosition(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders/close_position`,
        queryParams: undefined,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// Обновим функцию для создания лимитного ордера на покупку
function createLimitBuyOrder(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/orders`,
        bodyParams: {
            client_order_id: Date.now().toString(),
            product_id: requestParams.product_id,
            side: 'BUY',
            order_configuration: {
                limit_limit_gtc: {
                    base_size: requestParams.size,
                    limit_price: requestParams.price,
                    post_only: true
                }
            }
        },
        isPublic: false,
    });
}
