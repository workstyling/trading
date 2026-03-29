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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESTBase = void 0;
const jwt_generator_1 = require("../jwt-generator");
const node_fetch_1 = __importStar(require("node-fetch"));
const constants_1 = require("../constants");
const errors_1 = require("./errors");
class RESTBase {
    constructor(key, secret) {
        if (!key || !secret) {
            console.log('Could not authenticate. Only public endpoints accessible.');
        }
        this.apiKey = key;
        this.apiSecret = secret;
    }
    request(options) {
        const { method, endpoint, isPublic } = options;
        let { queryParams, bodyParams } = options;
        queryParams = queryParams ? this.filterParams(queryParams) : {};
        if (bodyParams !== undefined)
            bodyParams = bodyParams ? this.filterParams(bodyParams) : {};
        return this.prepareRequest(method, endpoint, queryParams, bodyParams, isPublic);
    }
    prepareRequest(httpMethod, urlPath, queryParams, bodyParams, isPublic) {
        const headers = this.setHeaders(httpMethod, urlPath, isPublic);
        const requestOptions = {
            method: httpMethod,
            headers: headers,
            body: JSON.stringify(bodyParams),
        };
        const queryString = this.buildQueryString(queryParams);
        const url = `https://${constants_1.BASE_URL}${urlPath}${queryString}`;
        return this.sendRequest(headers, requestOptions, url);
    }
    sendRequest(headers, requestOptions, url) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = yield (0, node_fetch_1.default)(url, requestOptions);
            const responseText = yield response.text();
            (0, errors_1.handleException)(response, responseText, response.statusText);
            return responseText;
        });
    }
    setHeaders(httpMethod, urlPath, isPublic) {
        const headers = new node_fetch_1.Headers();
        headers.append('Content-Type', 'application/json');
        headers.append('User-Agent', constants_1.USER_AGENT);
        if (this.apiKey !== undefined && this.apiSecret !== undefined)
            headers.append('Authorization', `Bearer ${(0, jwt_generator_1.generateToken)(httpMethod, urlPath, this.apiKey, this.apiSecret)}`);
        else if (isPublic == undefined || isPublic == false)
            throw new Error('Attempting to access authenticated endpoint with invalid API_KEY or API_SECRET.');
        return headers;
    }
    filterParams(data) {
        const filteredParams = {};
        for (const key in data) {
            if (data[key] !== undefined) {
                filteredParams[key] = data[key];
            }
        }
        return filteredParams;
    }
    buildQueryString(queryParams) {
        if (!queryParams || Object.keys(queryParams).length === 0) {
            return '';
        }
        const queryString = Object.entries(queryParams)
            .flatMap(([key, value]) => {
            if (Array.isArray(value)) {
                return value.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
            }
            else {
                return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
            }
        })
            .join('&');
        return `?${queryString}`;
    }
}
exports.RESTBase = RESTBase;
