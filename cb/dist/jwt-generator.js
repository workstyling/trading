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
exports.generateToken = generateToken;
const constants_1 = require("./constants");
const jwt = __importStar(require("jsonwebtoken"));
const crypto = __importStar(require("crypto"));
function generateToken(requestMethod, requestPath, apiKey, apiSecret) {
    const uri = `${requestMethod} ${constants_1.BASE_URL}${requestPath}`;
    const payload = {
        iss: constants_1.JWT_ISSUER,
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        sub: apiKey,
        uri,
    };
    const header = {
        alg: constants_1.ALGORITHM,
        kid: apiKey,
        nonce: crypto.randomBytes(16).toString('hex'),
    };
    const options = {
        algorithm: constants_1.ALGORITHM,
        header: header,
    };
    return jwt.sign(payload, apiSecret, options);
}
