import DataPack from 'edinburgh/datapack';
import { warpsocket, Socket, StreamTypeBase, pushModel, ServerProxy, logLevel } from './server.js';
import { SERVER_MESSAGES, CLIENT_MESSAGES } from './protocol.js';
import * as E from 'edinburgh';
import type { HttpRequest, HttpResponse } from 'warpsocket';

let mainApi: object | undefined;

/** @internal Used by the dashboard module to introspect the user's API. */
export function getMainApi(): object | undefined { return mainApi; }

export const socketProxies = new Map<number, Map<number, any>>(); // {socketId: {proxyId: proxyObject}}

export interface Request {
    socketId: number;
    requestId: number;
    token: Uint8Array;
}

export function handleOpen(socketId: number, ip: string) {
    if (logLevel >= 1) console.log('[lowlander] Client connected', socketId, ip);
}

function send(socketIdOrChannel: number|string|Uint8Array, ...data: any) {
    warpsocket.send(socketIdOrChannel, DataPack.createUint8Array(...data));
}

function sendError(socketId: number, requestId: number, message: string) {
    console.warn('Sending error', message);
    send(socketId, requestId, SERVER_MESSAGES.error, message);
}

let dashboardPassword = '';
/** @internal Used by the dashboard module to authenticate requests. */
export function getPassword(): string { return dashboardPassword; }

export async function handleStart(arg: any) {
    const { apiFile, password } = arg;
    dashboardPassword = password;
    if (logLevel >= 1) console.log('[lowlander] Worker started, loading', apiFile);
    mainApi = await import(apiFile);
}

export async function handleHttpRequest(req: HttpRequest, res: HttpResponse): Promise<void> {
    const handler = (mainApi as any)?.handleHttpRequest;
    if (typeof handler === 'function') {
        return handler(req, res);
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('Not found');
}


export async function handleBinaryMessage(message: Uint8Array, socketId: number) {
    if (logLevel >= 2) console.log('[lowlander] handleBinaryMessage socket', socketId, 'bytes', message.length, 'hex', Array.from(message.slice(0, 16)).map(b => b.toString(16).padStart(2,'0')).join(' '));
    const pack = new DataPack(message);
    let requestId: number;
    let type: number;
    try {
        requestId = pack.readPositiveInt();
        type = pack.readNumber();
    } catch (e: any) {
        console.error('[lowlander] Failed to parse message header:', e.message, 'hex:', Array.from(message.slice(0, 16)).map(b => b.toString(16).padStart(2,'0')).join(' '));
        return;
    }

    if (type === CLIENT_MESSAGES.cancel) {
        // Delete server proxy object, if any
        const cancelRequestId = pack.readPositiveInt();
        const proxies = socketProxies.get(socketId);
        if (proxies) {
            /** Call `onDrop()` on a proxy if it has one. Runs in a transaction; errors are logged. */
            const proxy = proxies.get(cancelRequestId);
            proxies.delete(cancelRequestId);
            if (proxy && typeof proxy.onDrop === 'function') {
                try {
                    await E.transact(() => proxy.onDrop());
                } catch (err: any) {
                    console.error('cancel request onDrop error', err);
                }
            }
        }

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
        // `_dashboard` is the one underscore-prefixed name reserved for the
        // dashboard module; everything else with a leading underscore is private.
        // Also block: classes (typeof === 'function' but not callable as plain
        // function), and Object.prototype methods accessible via prototype chain.
        if (
            typeof func !== 'function' ||
            (methodName.startsWith('_') && methodName !== '_dashboard') ||
            Function.prototype.toString.call(func).trimStart().startsWith('class ') ||
            Object.prototype.hasOwnProperty.call(Object.prototype, methodName)
        ) {
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
            let pendingPacket: Uint8Array | undefined;
            await E.transact(async () => {
                let response = await func.apply(api, params);
                if (logLevel >= 2) console.log('[lowlander] Called', methodName, 'with', params, '->', typeof response === 'object' && response ? response.toString() : JSON.stringify(response));

                // Result processing/serialization should be within the transaction, as it may involve (lazy) loading models.
                // The actual socket send remains deferred until after commit.

                // NOTE: Use duck-typing instead of instanceof for ServerProxy and StreamTypeBase,
                // because api.js and wshandler.js each bundle their own copy of server.ts,
                // so instanceof checks across those two bundles always return false.
                // E.Model is safe to use because edinburgh is externalized (shared).
                if (response !== null && typeof response === 'object' && 'api' in response && 'value' in response) {
                    const serverProxyResponse = response as ServerProxy<any, any>;
                    let proxies = socketProxies.get(socketId);
                    if (!proxies) socketProxies.set(socketId, proxies = new Map());
                    if (logLevel >= 3) console.log('[lowlander] Setting proxy id', requestId, 'for socket', socketId);
                    proxies.set(requestId, serverProxyResponse.api);

                    if (serverProxyResponse.value !== null && typeof serverProxyResponse.value === 'object' && (serverProxyResponse.value as any)._instance instanceof E.Model) {
                        const streamValue = serverProxyResponse.value as unknown as StreamTypeBase<any>;
                        const StreamType = streamValue.constructor as typeof StreamTypeBase<any>;
                        const instance = streamValue._instance;

                        const virtualSocketId = warpsocket.createVirtualSocket(socketId, DataPack.createUint8Array(requestId, SERVER_MESSAGES.model_data));
                        virtualSocketIds.push(virtualSocketId);
                        pushModel(virtualSocketId, instance, 0, StreamType, 1);

                        const cacheMs = StreamType.cache !== undefined ? StreamType.cache * 1000 : undefined;
                        pendingPacket = DataPack.createUint8Array(requestId, SERVER_MESSAGES.response_proxy_model, virtualSocketIds, instance.getPrimaryKeyHash() + StreamType.id, cacheMs);
                    } else {
                        pendingPacket = DataPack.createUint8Array(requestId, SERVER_MESSAGES.response_proxy, serverProxyResponse.value, virtualSocketIds);
                    }

                } else if (response !== null && typeof response === 'object' && (response as any)._instance instanceof E.Model) {
                    const streamResponse = response as unknown as StreamTypeBase<any>;
                    const StreamType = streamResponse.constructor as typeof StreamTypeBase<any>;
                    const instance = streamResponse._instance;

                    // Create a virtual socket for the model updates, prefixed by requestId + 'd'
                    const virtualSocketId = warpsocket.createVirtualSocket(socketId, DataPack.createUint8Array(requestId, SERVER_MESSAGES.model_data));
                    virtualSocketIds.push(virtualSocketId);

                    // Push the model (and any linked models) to the client
                    pushModel(virtualSocketId, instance, 0, StreamType, 1);

                    // Then respond, indicating which row should be top level
                    const cacheMs = StreamType.cache !== undefined ? StreamType.cache * 1000 : undefined;
                    pendingPacket = DataPack.createUint8Array(requestId, SERVER_MESSAGES.response_model, virtualSocketIds, instance.getPrimaryKeyHash() + StreamType.id, cacheMs);
                } else {
                    // A regular result
                    pendingPacket = DataPack.createUint8Array(requestId, SERVER_MESSAGES.response, response, virtualSocketIds);
                }
            });
            // Send response after transaction has committed
            warpsocket.send(socketId, pendingPacket!);
        } catch (error: any) {
            console.error('RPC error', error);
            sendError(socketId, requestId, error.message || 'Internal error');
        }
    } else {
        sendError(socketId, requestId, `Unknown message type: ${type}`);
    }
}

export async function handleClose(socketId: number) {
    if (logLevel >= 1) console.log('[lowlander] Client disconnected', socketId);
    const proxies = socketProxies.get(socketId);
    if (!proxies) return;
    socketProxies.delete(socketId);
    if (!proxies.values().some(p => typeof p.onDrop === 'function')) return;
    
    await E.transact(async () => {
        for (const proxy of proxies.values()) {
            if (typeof proxy?.onDrop === 'function') {
                try {
                    await proxy.onDrop();
                } catch (err: any) {
                    console.error('handleClose onDrop error', err);
                }
            }
        }
    });
}
