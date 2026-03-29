"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleException = handleException;
class CoinbaseError extends Error {
    constructor(message, statusCode, response) {
        super(message);
        this.name = 'CoinbaseError';
        this.statusCode = statusCode;
        this.response = response;
    }
}
function handleException(response, responseText, reason) {
    let message;
    if ((400 <= response.status && response.status <= 499) ||
        (500 <= response.status && response.status <= 599)) {
        if (response.status == 403 &&
            responseText.includes('"error_details":"Missing required scopes"')) {
            message = `${response.status} Coinbase Error: Missing Required Scopes. Please verify your API keys include the necessary permissions.`;
        }
        else
            message = `${response.status} Coinbase Error: ${reason} ${responseText}`;
        throw new CoinbaseError(message, response.status, response);
    }
}
