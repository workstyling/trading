"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.allocatePortfolio = allocatePortfolio;
exports.getPerpetualsPortfolioSummary = getPerpetualsPortfolioSummary;
exports.listPerpetualsPositions = listPerpetualsPositions;
exports.getPerpertualsPosition = getPerpertualsPosition;
exports.getPortfolioBalances = getPortfolioBalances;
exports.optInOutMultiAssetCollateral = optInOutMultiAssetCollateral;
const constants_1 = require("../constants");
const request_types_1 = require("./types/request-types");
// [POST] Allocate Portfolio
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_allocateportfolio
function allocatePortfolio(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/intx/allocate`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
// [GET] Get Perpetuals Portfolio Summary
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getintxportfoliosummary
function getPerpetualsPortfolioSummary({ portfolioUuid }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/intx/portfolio/${portfolioUuid}`,
        isPublic: false,
    });
}
// [GET] List Perpetuals Positions
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getintxpositions
function listPerpetualsPositions({ portfolioUuid }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/intx/positions/${portfolioUuid}`,
        isPublic: false,
    });
}
// [GET] Get Perpetuals Position
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getintxposition
function getPerpertualsPosition({ portfolioUuid, symbol }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/intx/positions/${portfolioUuid}/${symbol}`,
        isPublic: false,
    });
}
// [GET] Get Portfolio Balances
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getintxbalances
function getPortfolioBalances({ portfolioUuid }) {
    return this.request({
        method: request_types_1.method.GET,
        endpoint: `${constants_1.API_PREFIX}/intx/balances/${portfolioUuid}`,
        isPublic: false,
    });
}
// [POST] Opt In or Out of Multi Asset Collateral
// Official Documentation: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_intxmultiassetcollateral
function optInOutMultiAssetCollateral(requestParams) {
    return this.request({
        method: request_types_1.method.POST,
        endpoint: `${constants_1.API_PREFIX}/intx/multi_asset_collateral`,
        bodyParams: requestParams,
        isPublic: false,
    });
}
