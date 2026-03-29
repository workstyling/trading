"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAccount = getAccount;
exports.listAccounts = listAccounts;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] Get Account
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getaccount
function getAccount({ accountUuid }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/accounts/${accountUuid}`,
        isPublic: false,
    });
}
// [GET] List Accounts
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getaccounts
function listAccounts(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/accounts`,
        queryParams: requestParams,
        isPublic: false,
    });
}
