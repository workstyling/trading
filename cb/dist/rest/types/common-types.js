"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IntradayMarginSetting = exports.ProductVenue = exports.Granularity = exports.StopDirection = exports.OrderSide = exports.SortBy = exports.OrderPlacementSource = exports.MarginType = exports.PortfolioType = exports.ExpiringContractStatus = exports.ContractExpiryType = exports.ProductType = void 0;
// ----- ENUMS -----
var ProductType;
(function (ProductType) {
    ProductType["UNKNOWN"] = "UNKNOWN_PRODUCT_TYPE";
    ProductType["SPOT"] = "SPOT";
    ProductType["FUTURE"] = "FUTURE";
})(ProductType || (exports.ProductType = ProductType = {}));
var ContractExpiryType;
(function (ContractExpiryType) {
    ContractExpiryType["UNKNOWN"] = "UNKNOWN_CONTRACT_EXPIRY_TYPE";
    ContractExpiryType["EXPIRING"] = "EXPIRING";
    ContractExpiryType["PERPETUAL"] = "PERPETUAL";
})(ContractExpiryType || (exports.ContractExpiryType = ContractExpiryType = {}));
var ExpiringContractStatus;
(function (ExpiringContractStatus) {
    ExpiringContractStatus["UNKNOWN"] = "UNKNOWN_EXPIRING_CONTRACT_STATUS";
    ExpiringContractStatus["UNEXPIRED"] = "STATUS_UNEXPIRED";
    ExpiringContractStatus["EXPIRED"] = "STATUS_EXPIRED";
    ExpiringContractStatus["ALL"] = "STATUS_ALL";
})(ExpiringContractStatus || (exports.ExpiringContractStatus = ExpiringContractStatus = {}));
var PortfolioType;
(function (PortfolioType) {
    PortfolioType["UNDEFINED"] = "UNDEFINED";
    PortfolioType["DEFAULT"] = "DEFAULT";
    PortfolioType["CONSUMER"] = "CONSUMER";
    PortfolioType["INTX"] = "INTX";
})(PortfolioType || (exports.PortfolioType = PortfolioType = {}));
var MarginType;
(function (MarginType) {
    MarginType["CROSS"] = "CROSS";
    MarginType["ISOLATED"] = "ISOLATED";
})(MarginType || (exports.MarginType = MarginType = {}));
var OrderPlacementSource;
(function (OrderPlacementSource) {
    OrderPlacementSource["UNKNOWN"] = "UNKNOWN_PLACEMENT_SOURCE";
    OrderPlacementSource["RETAIL_SIMPLE"] = "RETAIL_SIMPLE";
    OrderPlacementSource["RETAIL_ADVANCED"] = "RETAIL_ADVANCED";
})(OrderPlacementSource || (exports.OrderPlacementSource = OrderPlacementSource = {}));
var SortBy;
(function (SortBy) {
    SortBy["UNKNOWN"] = "UNKNOWN_SORT_BY";
    SortBy["LIMIT_PRICE"] = "LIMIT_PRICE";
    SortBy["LAST_FILL_TIME"] = "LAST_FILL_TIME";
})(SortBy || (exports.SortBy = SortBy = {}));
var OrderSide;
(function (OrderSide) {
    OrderSide["BUY"] = "BUY";
    OrderSide["SELL"] = "SELL";
})(OrderSide || (exports.OrderSide = OrderSide = {}));
var StopDirection;
(function (StopDirection) {
    StopDirection["UP"] = "STOP_DIRECTION_STOP_UP";
    StopDirection["DOWN"] = "STOP_DIRECTION_STOP_DOWN";
})(StopDirection || (exports.StopDirection = StopDirection = {}));
var Granularity;
(function (Granularity) {
    Granularity["UNKNOWN"] = "UNKNOWN_GRANULARITY";
    Granularity["ONE_MINUTE"] = "ONE_MINUTE";
    Granularity["FIVE_MINUTE"] = "FIVE_MINUTE";
    Granularity["FIFTEEN_MINUTE"] = "FIFTEEN_MINUTE";
    Granularity["THIRTY_MINUTE"] = "THIRTY_MINUTE";
    Granularity["ONE_HOUR"] = "ONE_HOUR";
    Granularity["TWO_HOUR"] = "TWO_HOUR";
    Granularity["SIX_HOUR"] = "SIX_HOUR";
    Granularity["ONE_DAY"] = "ONE_DAY";
})(Granularity || (exports.Granularity = Granularity = {}));
var ProductVenue;
(function (ProductVenue) {
    ProductVenue["UNKNOWN"] = "UNKNOWN_VENUE_TYPE";
    ProductVenue["CBE"] = "CBE";
    ProductVenue["FCM"] = "FCM";
    ProductVenue["INTX"] = "INTX";
})(ProductVenue || (exports.ProductVenue = ProductVenue = {}));
var IntradayMarginSetting;
(function (IntradayMarginSetting) {
    IntradayMarginSetting["UNSPECIFIED"] = "INTRADAY_MARGIN_SETTING_UNSPECIFIED";
    IntradayMarginSetting["STANDARD"] = "INTRADAY_MARGIN_SETTING_STANDARD";
    IntradayMarginSetting["INTRADAY"] = "INTRADAY_MARGIN_SETTING_INTRADAY";
})(IntradayMarginSetting || (exports.IntradayMarginSetting = IntradayMarginSetting = {}));
