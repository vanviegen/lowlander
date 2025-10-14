import type { Socket, ServerProxy } from '../server/server.js';
import {proxy, unproxy, clean, copy, NO_COPY} from 'aberdeen';
import DataPack from 'edinburgh/datapack';
import { SERVER_MESSAGES, CLIENT_MESSAGES } from '../server/protocol.js';
import type { PromiseProxy } from 'aberdeen';

/**
 * Transforms server-side `Socket<T>` arguments to client-side callback functions `(data: T) => void`.
 * 
 * @typeParam A - The server-side argument type
 */
type ClientProxyArg<A> = A extends Socket<infer U>
    ? (data: U) => void
    : A;

/**
 * Recursively transforms all server-side function arguments for client-side use.
 * 
 * @typeParam Args - Tuple of server-side argument types
 */
type ClientProxyArgs<Args extends any[]> = Args extends [infer A, ...infer Rest]
    ? [ClientProxyArg<A>, ...ClientProxyArgs<Rest>]
    : [];

/**
 * Transforms server-side return types for client-side use.
 * 
 * - Strips `Promise` wrappers
 * - `ServerProxy<API, RETURN>` → `PromiseProxy<RETURN> & {serverProxy: ClientProxyObject<API>}`
 * - Other types → `PromiseProxy<R>`
 * 
 * @typeParam R - The server-side return type
 */
type ClientProxyReturn<R> = R extends Promise<infer U>
    ? ClientProxyReturn<U>
    : R extends ServerProxy<infer API, infer RETURN>
        ? PromiseProxy<RETURN> & {promise: Promise<any>, serverProxy: ClientProxyObject<API>}
    : PromiseProxy<R> & {promise: Promise<any>};

/**
 * Transforms server-side function signatures for client-side proxy use.
 * 
 * @typeParam T - The server-side function type
 */
type ClientProxyFunction<T> = T extends (...args: infer Args) => infer Return
    ? (...args: ClientProxyArgs<Args>) => ClientProxyReturn<Return>
    : never;

/**
 * Transforms server-side API objects to client-side proxy objects with type-safe RPC methods.
 * 
 * @typeParam T - The server-side API object type
 */
type ClientProxyObject<T> = {
    [K in keyof T]: ClientProxyFunction<T[K]>
};


/**
 * WebSocket connection to a Lowlander server with type-safe RPC, automatic reconnection,
 * and reactive updates.
 * 
 * @typeParam T - The server-side API type (import from your server API file)
 * 
 * @example
 * ```ts
 * import type * as API from './server/api.js';
 * const conn = new Connection<typeof API>('ws://localhost:8080/');
 * 
 * // Simple RPC - returns PromiseProxy
 * const sum = conn.api.add(1, 2);
 * 
 * // Server proxy for stateful APIs
 * const auth = conn.api.authenticate('token');
 * const secret = auth.serverProxy.getSecret();
 * 
 * // Streaming with callbacks
 * conn.api.streamData(data => console.log(data));
 * 
 * // Use within Aberdeen reactive scopes
 * $(() => {
 *   dump(conn.isOnline());
 *   dump(sum);
 * });
 * ```
 */
export class Connection<T> {
    
    private ws?: WebSocket;
    private activeRequests = new Map<number, ActiveRequest>();
    private requestCounter = 0;
    private reconnectAttempts = 0;
    public _proxyCounter = 0;
    private onlineProxy = proxy(false);

    /**
     * Type-safe proxy to the server-side API. Methods return `PromiseProxy` objects
     * that work reactively in Aberdeen scopes. `ServerProxy` returns include a
     * `.serverProxy` property for accessing stateful server APIs.
     */
    public api: ClientProxyObject<T>;

    /**
     * @param url - WebSocket URL (e.g., 'ws://localhost:8080/')
     */
    constructor(public url: string) {
        this.api = new Proxy({connection: this, requestId: undefined} as ProxyTargetType, proxyHandlers);
        this.connect();
    }

    /**
     * Returns the current connection status. Reactive in Aberdeen scopes.
     */
    isOnline(): boolean { return this.onlineProxy.value; }

    /**
     * TODO: Add some more variations to isOnline, like isBusy and isReady (initials requests done)
     */

    private connect() {
        const ws = this.ws = new WebSocket(this.url);
        console.log(`Connecting to WebSocket at ${this.url}`);

        this.ws.onopen = () => {
            if (ws !== this.ws) return; // No longer the current connection
            console.log('WebSocket connected');
            this.onlineProxy.value = true;
            this.reconnectAttempts = 0;
            for(const request of this.activeRequests.values()) {
                request.resultProxy.busy = true;
                this.ws!.send(request.requestBuffer);
            }
        };
        
        this.ws.onclose = () => {
            if (ws !== this.ws) return; // No longer the current connection
            console.log('WebSocket disconnected');
            this.reconnect();
        };
        
        this.ws.onerror = (error) => {
            if (ws !== this.ws) return; // No longer the current connection
            console.error('WebSocket error:', error);
            this.reconnect();
        };
        
        this.ws.onmessage = async (event) => {
            if (ws !== this.ws) return; // No longer the current connection
            const data = await event.data.arrayBuffer();
            const pack = new DataPack(new Uint8Array(data));
            // console.log(`onmessage: ${pack}`);
            const requestId = pack.readPositiveInt();

            const request = this.activeRequests.get(requestId);
            if (!request) return; // Raced
            const result = unproxy(request.resultProxy);

            const type = pack.read();
            if (typeof type === 'number') {
                // It's a callback invocation
                const callback = request.callbacks?.[type];
                const args: any[] = [];
                while(pack.readAvailable()) {
                    args.push(pack.read());
                }
                callback!(...args);
                return;
            }

            // This packet type does not represent the result for a request
            if (type === SERVER_MESSAGES.model_data) {
                request.database ||= new Map();
                const dbKey = pack.readNumber();
                const delta = pack.read({model: function(linkHash: number) {
                    const linkedModel = request.database!.get(linkHash);
                    if (!linkedModel) console.error('Unknown linked model hash ' + linkHash);
                    return linkedModel;
                }});
                console.log('incoming model_data', requestId, dbKey, delta);
                if (!delta) {
                    request.database.delete(dbKey);
                    return;
                }
                let org = request.database.get(dbKey);
                if (org) {
                    // We know each of the provided keys to be complete.
                    // Doing a single merge wouldn't delete nested keys that have disappeared.
                    for(const key of Object.keys(delta)) {
                        copy(org, key, delta[key]);
                    }
                }
                else {
                    request.database.set(dbKey, proxy(delta));
                }
                return;
            }

            // Each request should get one of these packet types as a response
            if (type === SERVER_MESSAGES.error) {
                const errorMessage = pack.readString();
                request.resultProxy.error = new Error(errorMessage);
                console.log(`incoming error requestId=${requestId} message=${errorMessage}`);
            } else if (type === SERVER_MESSAGES.response) {
                request.resultProxy.value = pack.read();
                request.virtualSocketIds = pack.read() as number[] | undefined;
                request.hasServerProxy = pack.readBoolean();
                console.log(`incoming response requestId=${requestId} value=${result.value} virtualSocketIds=${request.virtualSocketIds} hasServerProxy=${request.hasServerProxy}`);

            } else if (type === SERVER_MESSAGES.response_model) {
                request.virtualSocketIds = pack.read() as number[]; // There must be at least one, for the model stream
                const dbKey = pack.readNumber();
                const obj = request.database?.get(dbKey);
                console.log(`incoming response_model requestId=${requestId} dbKey=${dbKey} obj=${obj}`);
                if (obj) {
                    request.resultProxy.value = proxy(obj);
                } else {
                    request.resultProxy.error = new Error('Unknown database key ' + dbKey);
                }

            } else {
                throw new Error('Unknown message type ' + type);
            }

            // Common cleanup for all response types

            if (!request.hasServerProxy && !request.virtualSocketIds?.length) {
                this.activeRequests.delete(requestId);
            }

            if (!request.hasServerProxy) {
                delete (request.resultProxy as any).serverProxy;
            }

            request.resultProxy.busy = false;

            if (request.resolve) {
                // This does not happen on reconnect
                if (result.error != null) {
                    console.error(result.error);
                    request.reject!(result.error);
                } else {
                    request.resolve(result.value);
                }
                delete request.resolve;
                delete request.reject;
            }
        };
    }

    private reconnect() {
        this.ws = undefined;

        this.onlineProxy.value = false;

        // Reconnect with exponential backoff
        const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts), 20000);
        this.reconnectAttempts++;
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(this.connect.bind(this), delay);
    }

    /** @internal */
    public _createMethodStub(methodName: string, proxyId?: number) {
        return (...params: any[]) => {
            const result = {busy: true} as PromiseProxy<any> & {promise: Promise<any>} & {serverProxy: any};
            const resultProxy = proxy(result);

            const requestId = ++this.requestCounter;

            const pack = new DataPack();
            pack.write(requestId).write(CLIENT_MESSAGES.call).write(proxyId).write(methodName);

            let callbacks;
            pack.writeCollection("array", () => {
                for(const param of params) {
                    if (typeof param === 'function') {
                        callbacks ||= [];
                        pack.writeCustom('cb', callbacks.length);
                        callbacks.push(param);
                    } else {
                        pack.write(param);
                    }
                }
            });

            const request: ActiveRequest = { resultProxy, requestBuffer: pack.toUint8Array(true), requestId, connection: this, callbacks };
            result.serverProxy = new Proxy(request, proxyHandlers);
            result.promise = new Promise((resolve, reject) => {
                request.resolve = resolve;
                request.reject = reject;
            });

            this.activeRequests.set(requestId, request);

            console.log(`outgoing call requestId=${requestId} method=${methodName} params=`, params);

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(request.requestBuffer);
            }

            clean(() => {
                this.activeRequests.delete(requestId);
                if (request.virtualSocketIds?.length || request.hasServerProxy) {
                    console.log(`outgoing cancel requestId=${request.requestId} virtualSocketIds=${request.virtualSocketIds} hasServerProxy=${request.hasServerProxy}`);
                    const data = DataPack.createUint8Array(
                        ++this.requestCounter,
                        CLIENT_MESSAGES.cancel,
                        request.requestId,
                        request.virtualSocketIds,
                    );
                    this.ws?.send(data);
                }
            });

            return resultProxy;
        }
    }
}

const proxyHandlers: ProxyHandler<any> = {
    get(target: ProxyTargetType, prop: string) {
        if (target.serverProxyCache?.has(prop)) {
            return target.serverProxyCache.get(prop);
        }
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            // When someone awaits the proxy, we should not treat it as a remote method call
            return undefined;
        }
        if (prop === 'constructor') {
            return {name: 'ServerProxy-' + target.requestId};
        }
        const result = target.connection._createMethodStub(prop, target.requestId);
        if (!target.serverProxyCache) target.serverProxyCache = new Map();
        target.serverProxyCache.set(prop, result);
        return result;
    },
    has(_target: ProxyTargetType, prop: string | symbol) {
        return typeof prop === 'string' || prop === NO_COPY;
    }
}

interface ProxyTargetType {
    connection: Connection<any>;
    requestId: number | undefined;
    serverProxyCache?: Map<string, () => PromiseProxy<any>>;
}

interface ActiveRequest extends ProxyTargetType {
    resultProxy: PromiseProxy<any>;
    callbacks?: ((...args: any[]) => void)[];
    virtualSocketIds?: number[];
    database?: Map<number, Record<any,any>>; // For model streams
    requestBuffer: Uint8Array;
    requestId: number; // Client-generated unique ID for this request
    hasServerProxy?: boolean; // When true, the requestId has an object associated on the server side (which needs to be dropped on 'clean')
    resolve?: (value: any) => void;
    reject?: (error: any) => void;
}
