"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESTClient = void 0;
const rest_base_1 = require("./rest-base");
const Accounts = __importStar(require("./accounts"));
const Converts = __importStar(require("./converts"));
const DataAPI = __importStar(require("./dataAPI"));
const Fees = __importStar(require("./fees"));
const Futures = __importStar(require("./futures"));
const Orders = __importStar(require("./orders"));
const Payments = __importStar(require("./payments"));
const Perpetuals = __importStar(require("./perpetuals"));
const Portfolios = __importStar(require("./portfolios"));
const Products = __importStar(require("./products"));
const Public = __importStar(require("./public"));
class RESTClient extends rest_base_1.RESTBase {
    constructor(key, secret) {
        super(key, secret);
        // =============== ACCOUNTS endpoints ===============
        this.getAccount = Accounts.getAccount.bind(this);
        this.listAccounts = Accounts.listAccounts.bind(this);
        // =============== CONVERTS endpoints ===============
        this.createConvertQuote = Converts.createConvertQuote.bind(this);
        this.commitConvertTrade = Converts.commitConvertTrade.bind(this);
        this.getConvertTrade = Converts.getConvertTrade.bind(this);
        // =============== DATA API endpoints ===============
        this.getAPIKeyPermissions = DataAPI.getAPIKeyPermissions.bind(this);
        // =============== FEES endpoints ===============
        this.getTransactionSummary = Fees.getTransactionSummary.bind(this);
        // =============== FUTURES endpoints ===============
        this.getFuturesBalanceSummary = Futures.getFuturesBalanceSummary.bind(this);
        this.getIntradayMarginSetting = Futures.getIntradayMarginSetting.bind(this);
        this.setIntradayMarginSetting = Futures.setIntradayMarginSetting.bind(this);
        this.getCurrentMarginWindow = Futures.getCurrentMarginWindow.bind(this);
        this.listFuturesPositions = Futures.listFuturesPositions.bind(this);
        this.getFuturesPosition = Futures.getFuturesPosition.bind(this);
        this.scheduleFuturesSweep = Futures.scheduleFuturesSweep.bind(this);
        this.listFuturesSweeps = Futures.listFuturesSweeps.bind(this);
        this.cancelPendingFuturesSweep = Futures.cancelPendingFuturesSweep.bind(this);
        // =============== ORDERS endpoints ===============
        this.createOrder = Orders.createOrder.bind(this);
        this.cancelOrders = Orders.cancelOrders.bind(this);
        this.editOrder = Orders.editOrder.bind(this);
        this.editOrderPreview = Orders.editOrderPreview.bind(this);
        this.listOrders = Orders.listOrders.bind(this);
        this.listFills = Orders.listFills.bind(this);
        this.getOrder = Orders.getOrder.bind(this);
        this.previewOrder = Orders.previewOrder.bind(this);
        this.closePosition = Orders.closePosition.bind(this);
        // =============== PAYMENTS endpoints ===============
        this.listPaymentMethods = Payments.listPaymentMethods.bind(this);
        this.getPaymentMethod = Payments.getPaymentMethod.bind(this);
        // =============== PERPETUALS endpoints ===============
        this.allocatePortfolio = Perpetuals.allocatePortfolio.bind(this);
        this.getPerpetualsPortfolioSummary = Perpetuals.getPerpetualsPortfolioSummary.bind(this);
        this.listPerpetualsPositions = Perpetuals.listPerpetualsPositions.bind(this);
        this.getPerpetualsPosition = Perpetuals.getPerpertualsPosition.bind(this);
        this.getPortfolioBalances = Perpetuals.getPortfolioBalances.bind(this);
        this.optInOutMultiAssetCollateral = Perpetuals.optInOutMultiAssetCollateral.bind(this);
        // =============== PORTFOLIOS endpoints ===============
        this.listPortfolios = Portfolios.listPortfolios.bind(this);
        this.createPortfolio = Portfolios.createPortfolio.bind(this);
        this.deletePortfolio = Portfolios.deletePortfolio.bind(this);
        this.editPortfolio = Portfolios.editPortfolio.bind(this);
        this.movePortfolioFunds = Portfolios.movePortfolioFunds.bind(this);
        this.getPortfolioBreakdown = Portfolios.getPortfolioBreakdown.bind(this);
        // =============== PRODUCTS endpoints ===============
        this.getBestBidAsk = Products.getBestBidAsk.bind(this);
        this.getProductBook = Products.getProductBook.bind(this);
        this.listProducts = Products.listProducts.bind(this);
        this.getProduct = Products.getProduct.bind(this);
        this.getProductCandles = Products.getProductCandles.bind(this);
        this.getMarketTrades = Products.getMarketTrades.bind(this);
        // =============== PUBLIC endpoints ===============
        this.getServerTime = Public.getServerTime.bind(this);
        this.getPublicProductBook = Public.getPublicProductBook.bind(this);
        this.listPublicProducts = Public.listPublicProducts.bind(this);
        this.getPublicProduct = Public.getPublicProduct.bind(this);
        this.getPublicProductCandles = Public.getPublicProductCandles.bind(this);
        this.getPublicMarketTrades = Public.getPublicMarketTrades.bind(this);
    }
}
exports.RESTClient = RESTClient;
