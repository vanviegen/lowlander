// requestId + callbackIndex + callback arguments

// or

// requestId + one of these types:
export const SERVER_MESSAGES = {
    error: 'e', // followed by errorMessage
    response: 'r', // followed by result + virtualSocketIds
    response_proxy: 'p', // followed by result + virtualSocketIds (like above, but indicate that a ServerProxy has been created for this request)
    response_model: 'm', // followed by virtualSocketIds + dbKey + cacheMs (undefined = no caching/dedup)
    model_data: 'd', // followed by dbKey + commitId + delta
};

// The virtualSocketIds in a response or response_model is stored by the client and must
// be provided to 'cancel'.
// dbKey is a stochastically unique identifier for a subset of a model instance, defined as primaryKeyHash + steamType.id

// requestId + one of these types:
export const CLIENT_MESSAGES = {
    call: 1, // followed by proxyId/undefined + methodName + params + ...
    cancel: 2, // followed by cancelRequestId + virtualSocketIds/undefined
};
