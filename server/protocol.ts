// requestId + callbackIndex + callback arguments

// or

// requestId + one of these types:
export const SERVER_MESSAGES = {
    error: 'e', // followed by errorMessage
    response: 'r', // followed by result + virtualSocketIds + hasServerProxy:bool
    response_model: 'm', // followed by virtualSocketIds + primaryKeyHash
    model_data: 'd', // followed by primaryKeyHash + delta
};

// requestId + one of these types:
export const CLIENT_MESSAGES = {
    call: 1, // followed by proxyId/undefined + methodName + params + ...
    cancel: 2, // followed by cancelRequestId + virtualSocketIds/undefined
};
