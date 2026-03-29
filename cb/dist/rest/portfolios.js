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
exports.listPortfolios = listPortfolios;
exports.createPortfolio = createPortfolio;
exports.movePortfolioFunds = movePortfolioFunds;
exports.getPortfolioBreakdown = getPortfolioBreakdown;
exports.deletePortfolio = deletePortfolio;
exports.editPortfolio = editPortfolio;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [GET] List Portfolios
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getportfolios
function listPortfolios(requestParams) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/portfolios`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [POST] Create Portfolio
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_createportfolio
function createPortfolio(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/portfolios`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [POST] Move Portfolio Funds
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_moveportfoliofunds
function movePortfolioFunds(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/portfolios/move_funds`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Portfolio Breakdown
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getportfoliobreakdown
function getPortfolioBreakdown(_a) {
    var { portfolioUuid } = _a, requestParams = __rest(_a, ["portfolioUuid"]);
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/portfolios/${portfolioUuid}`,
        queryParams: requestParams,
        isPublic: false,
    });
}
// [DELETE] Delete Portfolio
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_deleteportfolio
function deletePortfolio({ portfolioUuid }) {
    return this.request({
        method: request_types_1.method.DELETE,
        endpoint: `${constants_1.API_PREFIX}/portfolios/${portfolioUuid}`,
        isPublic: false,
    });
}
// [PUT] Edit Portfolio
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_editportfolio
function editPortfolio(_a) {
    var { portfolioUuid } = _a, requestParams = __rest(_a, ["portfolioUuid"]);
    return this.request({
        method: request_types_1.method.PUT,
        endpoint: `${constants_1.API_PREFIX}/portfolios/${portfolioUuid}`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
