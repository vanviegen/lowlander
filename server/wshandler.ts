import * as warpsocket from 'warpsocket';
import DataPack from 'edinburgh/datapack';
import { Socket, StreamTypeBase, pushModel, ServerProxy } from './server.js';
import { SERVER_MESSAGES, CLIENT_MESSAGES } from './protocol.js';
import * as E from 'edinburgh';

let mainApi: object | undefined;

export const socketProxies = new Map<number, Map<number, any>>(); // {socketId: {proxyId: proxyObject}}

export interface Request {
    socketId: number;
    requestId: number;
    token: Uint8Array;
}

export function handleOpen(socketId: number, ip: string) {
    console.log('Client connected', socketId, ip);
}

function send(socketIdOrChannel: number|string|Uint8Array, ...data: any) {
    warpsocket.send(socketIdOrChannel, DataPack.createUint8Array(...data));
}

function sendError(socketId: number, requestId: number, message: string) {
    console.warn('Sending error', message);
    send(socketId, requestId, SERVER_MESSAGES.error, message);
}

export async function handleStart(apiFile: any) {
    console.log('Worker started, loading', apiFile);
    mainApi = await import(apiFile);
}


export async function handleBinaryMessage(message: Uint8Array, socketId: number) {
    const pack = new DataPack(message);
    const requestId = pack.readPositiveInt();
    const type = pack.readNumber();

    if (type === CLIENT_MESSAGES.cancel) {
        // Delete server proxy object, if any
        const cancelRequestId = pack.readPositiveInt();
        const proxies = socketProxies.get(socketId);
        if (proxies) proxies.delete(cancelRequestId);

        // Delete any virtual sockets created for this request
        for(const virtualSocketId of pack.read() || []) {
            // The second argument makes sure we're not deleting virtual
            // sockets created by other requests
            warpsocket.deleteVirtualSocket(virtualSocketId, socketId);
        }
    } else if (type === CLIENT_MESSAGES.call) {
        const proxyId = pack.read();
        let api: any;
        if (typeof proxyId === 'number') {
            const proxies = socketProxies.get(socketId);
            api = proxies?.get(proxyId);
            if (!api) {
                return sendError(socketId, requestId, `Proxy ${proxyId} not found`);
            }
        } else if (proxyId === undefined) {
            if (!mainApi) {
                return sendError(socketId, requestId, 'Server not ready');
            }
            api = mainApi;
        } else {
            return sendError(socketId, requestId, 'Invalid proxyId');
        }

        // Obtain function reference
        const methodName = pack.readString();
        let func = (api as any)[methodName];
        if (typeof func !== 'function' || methodName.startsWith('_')) {
            return sendError(socketId, requestId, `Method not found: ${methodName}`);
        }

        // Parse args
        const virtualSocketIds: number[] = [];
        const params = pack.read({
            cb: function(callbackIndex: number) {
                const virtualSocketId = warpsocket.createVirtualSocket(socketId, DataPack.createUint8Array(requestId, callbackIndex));
                virtualSocketIds.push(virtualSocketId);
                return new Socket(virtualSocketId);
            },
        });
        if (!Array.isArray(params)) {
            return sendError(socketId, requestId, `Params must be an array`);
        }

        try {
            await E.transact(async () => {
                let response = await func.apply(api, params);
                console.log('Called', methodName, 'with', params, '->', typeof response === 'object' && response ? response.toString() : JSON.stringify(response));

                // Result processing/sending should be within the transaction, as it may involve (lazy) loading models

                if (response instanceof ServerProxy) {
                    let proxies = socketProxies.get(socketId);
                    if (!proxies) socketProxies.set(socketId, proxies = new Map());
                    console.log('Setting proxy id', requestId, 'for socket', socketId);
                    proxies.set(requestId, response.api);
                    
                    send(socketId, requestId, SERVER_MESSAGES.response_proxy, response.value, virtualSocketIds);

                } else if (response instanceof StreamTypeBase) {
                    const StreamType = response.constructor as typeof StreamTypeBase<any>;
                    const instance = response._instance;

                    // Create a virtual socket for the model updates, prefixed by requestId + 'd'
                    const virtualSocketId = warpsocket.createVirtualSocket(socketId, DataPack.createUint8Array(requestId, SERVER_MESSAGES.model_data));
                    virtualSocketIds.push(virtualSocketId);

                    // Push the model (and any linked models) to the client
                    pushModel(virtualSocketId, instance, 0, StreamType, 1);

                    // Then respond, indicating which row should be top level
                    send(socketId, requestId, SERVER_MESSAGES.response_model, virtualSocketIds, instance.getPrimaryKeyHash() + StreamType.id);
                } else {
                    // A regular result
                    send(socketId, requestId, SERVER_MESSAGES.response, response, virtualSocketIds);
                }
            });
        } catch (error: any) {
            console.error('RPC error', error);
            sendError(socketId, requestId, error.message || 'Internal error');
        }
    } else {
        sendError(socketId, requestId, `Unknown message type: ${type}`);
    }
}

export function handleClose(socketId: number) {
    console.log('Client disconnected', socketId);
    socketProxies.delete(socketId);
}
