import type { Socket, ServerProxy, StreamTypeBase } from '../server/server.js';
import A from 'aberdeen';
import DataPack from 'edinburgh/datapack';
import { SERVER_MESSAGES, CLIENT_MESSAGES } from '../server/protocol.js';
import type { PromiseProxy } from 'aberdeen';

let logLevel = 0;

/** Set to 0-3 for increasing verbosity. */
export function setLogLevel(level: number) {
    logLevel = level;
}

// Sentinel key in commitIds entries: on initial creation, only DEFAULT_COMMIT is set
// (applies to all keys). Per-key entries are added on subsequent updates and take
// precedence. On deletion, DEFAULT_COMMIT guards against stale re-creates.
const DEFAULT_COMMIT = Symbol();

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
        ? PromiseProxy<RETURN> & {promise: Promise<RETURN>, serverProxy: ClientProxyObject<API>}
        : R extends StreamTypeBase<infer T>
            ? PromiseProxy<T> & {promise: Promise<T>}
            : PromiseProxy<R> & {promise: Promise<R>};

/**
 * Transforms server-side function signatures for client-side proxy use.
 * This type correctly handles function overloads by explicitly matching
 * up to 8 signatures and creating an intersection of the transformed types.
 *
 * @typeParam T - The server-side function type, which may be overloaded.
 */
// Yeah, this is ugly beyond belief, but TypeScript doesn't have a
// better way to handle function overloads in conditional types.
// The non-ugly version would be:
//
// type ClientProxyFunction<T> = T extends (...args: infer Args) => infer Return
//  ? (...args: ClientProxyArgs<Args>) => ClientProxyReturn<Return>
//    : never;
type ClientProxyFunction<T> = T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
    (...args: infer A4): infer R4;
    (...args: infer A5): infer R5;
    (...args: infer A6): infer R6;
    (...args: infer A7): infer R7;
    (...args: infer A8): infer R8;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
    & ((...args: ClientProxyArgs<A3>) => ClientProxyReturn<R3>)
    & ((...args: ClientProxyArgs<A4>) => ClientProxyReturn<R4>)
    & ((...args: ClientProxyArgs<A5>) => ClientProxyReturn<R5>)
    & ((...args: ClientProxyArgs<A6>) => ClientProxyReturn<R6>)
    & ((...args: ClientProxyArgs<A7>) => ClientProxyReturn<R7>)
    & ((...args: ClientProxyArgs<A8>) => ClientProxyReturn<R8>)
: T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
    (...args: infer A4): infer R4;
    (...args: infer A5): infer R5;
    (...args: infer A6): infer R6;
    (...args: infer A7): infer R7;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
    & ((...args: ClientProxyArgs<A3>) => ClientProxyReturn<R3>)
    & ((...args: ClientProxyArgs<A4>) => ClientProxyReturn<R4>)
    & ((...args: ClientProxyArgs<A5>) => ClientProxyReturn<R5>)
    & ((...args: ClientProxyArgs<A6>) => ClientProxyReturn<R6>)
    & ((...args: ClientProxyArgs<A7>) => ClientProxyReturn<R7>)
: T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
    (...args: infer A4): infer R4;
    (...args: infer A5): infer R5;
    (...args: infer A6): infer R6;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
    & ((...args: ClientProxyArgs<A3>) => ClientProxyReturn<R3>)
    & ((...args: ClientProxyArgs<A4>) => ClientProxyReturn<R4>)
    & ((...args: ClientProxyArgs<A5>) => ClientProxyReturn<R5>)
    & ((...args: ClientProxyArgs<A6>) => ClientProxyReturn<R6>)
: T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
    (...args: infer A4): infer R4;
    (...args: infer A5): infer R5;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
    & ((...args: ClientProxyArgs<A3>) => ClientProxyReturn<R3>)
    & ((...args: ClientProxyArgs<A4>) => ClientProxyReturn<R4>)
    & ((...args: ClientProxyArgs<A5>) => ClientProxyReturn<R5>)
: T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
    (...args: infer A4): infer R4;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
    & ((...args: ClientProxyArgs<A3>) => ClientProxyReturn<R3>)
    & ((...args: ClientProxyArgs<A4>) => ClientProxyReturn<R4>)
: T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
    (...args: infer A3): infer R3;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
    & ((...args: ClientProxyArgs<A3>) => ClientProxyReturn<R3>)
: T extends {
    (...args: infer A1): infer R1;
    (...args: infer A2): infer R2;
} ?
    & ((...args: ClientProxyArgs<A1>) => ClientProxyReturn<R1>)
    & ((...args: ClientProxyArgs<A2>) => ClientProxyReturn<R2>)
: T extends (...args: infer A) => infer R
    ? (...args: ClientProxyArgs<A>) => ClientProxyReturn<R>
    : never;

/**
 * Transforms server-side API objects to client-side proxy objects with type-safe RPC methods.
 * 
 * @typeParam T - The server-side API object type
 */
export type ClientProxyObject<T> = {
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
    /** @internal */
    public _proxyCounter = 0;
    private onlineProxy = A.proxy(false);
    private streamCache = new Map<string, StreamCacheEntry>();

    /**
     * Type-safe proxy to the server-side API. Methods return `PromiseProxy` objects
     * that work reactively in Aberdeen scopes. `ServerProxy` returns include a
     * `.serverProxy` property for accessing stateful server APIs.
     */
    public api: ClientProxyObject<T>;

    /**
     * @param url - WebSocket URL (e.g., 'ws://localhost:8080/'), or a fake WebSocket object for testing
     */
    constructor(public url: string | (() => WebSocket)) {
        this.api = new Proxy({connection: this, requestId: undefined} as ProxyTargetType, proxyHandlers);
        this.connect();
    }

    /**
     * Returns the current connection status. Reactive in Aberdeen scopes.
     */
    isOnline(): boolean { return this.onlineProxy.value; }

    private connect() {
        const ws: WebSocket = this.ws = typeof this.url === 'string'
            ? new WebSocket(this.url)
            : this.url();
        ws.binaryType = "arraybuffer";
        if (logLevel >= 1) console.log(`[lowlander] Connecting to WebSocket at ${typeof this.url === 'string' ? this.url : '[custom WebSocket]'}`);
 
        ws.onopen = () => {
            if (ws !== this.ws) return; // No longer the current connection
            if (logLevel >= 1) console.log('[lowlander] WebSocket connected');
            this.onlineProxy.value = true;
            this.reconnectAttempts = 0;
            for(const request of this.activeRequests.values()) {
                request.resultProxy.busy = true;
                this.ws!.send(request.requestBuffer as Uint8Array<ArrayBuffer>);
            }
        };
        
        ws.onclose = () => {
            if (ws !== this.ws) return; // No longer the current connection
            if (logLevel >= 1) console.log('[lowlander] WebSocket disconnected');
            this.reconnect();
        };
        
        ws.onerror = (error: any) => {
            if (ws !== this.ws) return; // No longer the current connection
            console.error('WebSocket error:', error);
            this.reconnect();
        };
        
        ws.onmessage = (event: any) => {
            if (ws !== this.ws) return; // No longer the current connection
            const pack = new DataPack(new Uint8Array(event.data));
            // console.log(`onmessage: ${pack}`);
            const requestId = pack.readPositiveInt();

            const request = this.activeRequests.get(requestId);
            if (!request) return; // Raced
            const result = A.unproxy(request.resultProxy);

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
                request.commitIds ||= new Map();
                const dbKeyHash = pack.readNumber();
                const commitId = pack.readNumber();
                const delta = pack.read({model: function(linkHash: number) {
                    const linkedModel = request.database!.get(linkHash);
                    if (!linkedModel) console.error('Unknown linked model hash ' + linkHash);
                    return linkedModel;
                }});
                if (logLevel >= 3) console.log('[lowlander] incoming model_data', requestId, dbKeyHash, commitId, delta);
                // Schedule cleanup: after 15s, all out-of-order messages for this commitId
                // must have arrived, so we can prune tracking entries at or below it.
                setTimeout(() => this.pruneCommitIds(request, commitId), 15000);
                let prevCommitIds = request.commitIds.get(dbKeyHash);
                if (!delta) {
                    // Stale delete: some key was already updated past this commitId
                    if (prevCommitIds && commitId < Math.max(...prevCommitIds.values())) return;
                    request.database.delete(dbKeyHash);
                    // Record delete's commitId so stale creates arriving later are rejected
                    request.commitIds.set(dbKeyHash, new Map([[DEFAULT_COMMIT, commitId]]));
                    return;
                }
                let org = request.database.get(dbKeyHash);
                if (org) {
                    // Update existing object
                    if (!prevCommitIds) {
                        prevCommitIds = new Map();
                        request.commitIds.set(dbKeyHash, prevCommitIds);
                    }
                    for (const key of Object.keys(delta)) {
                        if (commitId < (prevCommitIds.get(key) ?? prevCommitIds.get(DEFAULT_COMMIT) ?? -1)) continue;
                        if (delta[key] && typeof delta[key] === 'object') {
                            A.copy(org, key, delta[key]);
                        } else {
                            org[key] = delta[key];
                        }
                        prevCommitIds.set(key, commitId);
                    }
                } else {
                    // Create new object
                    if (prevCommitIds && commitId < (prevCommitIds.get(DEFAULT_COMMIT) ?? -1)) return; // Stale create
                    request.database.set(dbKeyHash, A.proxy(delta));
                    request.commitIds.set(dbKeyHash, new Map([[DEFAULT_COMMIT, commitId]]));
                }
                return;
            }

            // Each request should get one of these packet types as a response
            if (type === SERVER_MESSAGES.error) {
                const errorMessage = pack.readString();
                request.resultProxy.error = new Error(errorMessage);
                if (logLevel >= 2) console.log(`[lowlander] incoming error requestId=${requestId} message=${errorMessage}`);

            } else if (type === SERVER_MESSAGES.response || type === SERVER_MESSAGES.response_proxy) {
                request.resultProxy.value = pack.read();
                request.virtualSocketIds = pack.read() as number[] | undefined;
                request.hasServerProxy = type === SERVER_MESSAGES.response_proxy;
                if (logLevel >= 2) console.log(`[lowlander] incoming response requestId=${requestId} value=${result.value} virtualSocketIds=${request.virtualSocketIds} hasServerProxy=${request.hasServerProxy}`);

            } else if (type === SERVER_MESSAGES.response_model) {
                request.virtualSocketIds = pack.read() as number[]; // There must be at least one, for the model stream
                const dbKey = pack.readNumber();
                const cacheMs = pack.read() as number | undefined;
                const obj = request.database?.get(dbKey);
                if (logLevel >= 2) console.log(`[lowlander] incoming response_model requestId=${requestId} dbKey=${dbKey} cacheMs=${cacheMs} obj=${obj}`);
                if (obj) {
                    request.resultProxy.value = A.proxy(obj);
                } else {
                    request.resultProxy.error = new Error('Unknown database key ' + dbKey);
                }
                if (cacheMs !== undefined && request.cacheKey && !this.streamCache.has(request.cacheKey)) {
                    this.streamCache.set(request.cacheKey, {
                        request, cacheKey: request.cacheKey, cacheMs, refCount: 1,
                    });
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

        if (typeof this.url !== 'string') return; // No reconnect in test mode

        // Reconnect with exponential backoff
        const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts), 20000);
        this.reconnectAttempts++;
        if (logLevel >= 1) console.log(`[lowlander] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(this.connect.bind(this), delay);
    }

    private pruneCommitIds(request: ActiveRequest, maxCommitId: number) {
        if (!request.commitIds) return;
        for (const [hash, entry] of request.commitIds) {
            for (const [key, cid] of entry) {
                if (cid <= maxCommitId) entry.delete(key);
            }
            if (!entry.size) request.commitIds.delete(hash);
        }
    }

    /** @internal */
    public _createMethodStub(methodName: string, proxyId?: number) {
        return (...params: any[]) => {
            // Compute cache key (only when no callback params — callbacks aren't idempotent)
            const hasCallbacks = params.some(p => typeof p === 'function');
            const cacheKey = hasCallbacks ? undefined : (proxyId ?? '') + ':' + methodName + ':' + JSON.stringify(params);

            // Check stream cache for reuse
            if (cacheKey) {
                const cached = this.streamCache.get(cacheKey);
                if (cached) {
                    if (cached.lingerTimeout) {
                        clearTimeout(cached.lingerTimeout);
                        cached.lingerTimeout = undefined;
                    }
                    cached.refCount++;

                    if (logLevel >= 2) console.log(`[lowlander] reusing cached stream cacheKey=${cacheKey} refCount=${cached.refCount}`);

                    A.clean(() => {
                        cached.refCount--;
                        if (logLevel >= 2) console.log(`[lowlander] clean cached consumer cacheKey=${cacheKey} refCount=${cached.refCount}`);
                        if (cached.refCount <= 0) this.startLinger(cached);
                    });

                    return cached.request.resultProxy;
                }
            }

            const result = {busy: true} as PromiseProxy<any> & {promise: Promise<any>} & {serverProxy: any};
            const resultProxy = A.proxy(result);

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

            const request: ActiveRequest = { resultProxy, requestBuffer: pack.toUint8Array(true), requestId, connection: this, callbacks, cacheKey };
            result.serverProxy = new Proxy(request, proxyHandlers);
            result.promise = new Promise((resolve, reject) => {
                request.resolve = resolve;
                request.reject = reject;
            });

            this.activeRequests.set(requestId, request);

            if (logLevel >= 2) console.log(`[lowlander] outgoing call requestId=${requestId} method=${methodName} params=`, params);

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(request.requestBuffer as Uint8Array<ArrayBuffer>);
            }

            A.clean(() => {
                const cached = cacheKey ? this.streamCache.get(cacheKey) : undefined;
                if (cached && cached.request === request) {
                    cached.refCount--;
                    if (logLevel >= 2) console.log(`[lowlander] clean stream owner cacheKey=${cacheKey} refCount=${cached.refCount}`);
                    if (cached.refCount <= 0) this.startLinger(cached);
                    return;
                }
                this.cancelRequest(request);
            });

            return resultProxy;
        }
    }

    private cancelRequest(request: ActiveRequest) {
        this.activeRequests.delete(request.requestId);
        if (request.virtualSocketIds?.length || request.hasServerProxy) {
            if (logLevel >= 2) console.log(`[lowlander] outgoing cancel requestId=${request.requestId} virtualSocketIds=${request.virtualSocketIds} hasServerProxy=${request.hasServerProxy}`);
            const data = DataPack.createUint8Array(
                ++this.requestCounter,
                CLIENT_MESSAGES.cancel,
                request.requestId,
                request.virtualSocketIds,
            );
            this.ws?.send(data as Uint8Array<ArrayBuffer>);
        }
    }

    private startLinger(cached: StreamCacheEntry) {
        if (cached.lingerTimeout) clearTimeout(cached.lingerTimeout);
        if (logLevel >= 2) console.log(`[lowlander] start linger cacheKey=${cached.cacheKey} cacheMs=${cached.cacheMs}`);
        cached.lingerTimeout = setTimeout(() => {
            if (cached.refCount > 0) return;
            if (logLevel >= 2) console.log(`[lowlander] linger expired cacheKey=${cached.cacheKey}`);
            this.streamCache.delete(cached.cacheKey);
            this.cancelRequest(cached.request);
        }, cached.cacheMs);
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
        return typeof prop === 'string' || prop === A.NO_COPY;
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
    commitIds?: Map<number, Map<string | symbol, number>>; // dbKeyHash -> (key|DEFAULT_COMMIT) -> commitId
    requestBuffer: Uint8Array;
    requestId: number; // Client-generated unique ID for this request
    hasServerProxy?: boolean; // When true, the requestId has an object associated on the server side (which needs to be dropped on 'clean')
    cacheKey?: string; // For stream cache lookup
    resolve?: (value: any) => void;
    reject?: (error: any) => void;
}

interface StreamCacheEntry {
    request: ActiveRequest;
    cacheKey: string;
    cacheMs: number;
    refCount: number;
    lingerTimeout?: ReturnType<typeof setTimeout>;
}
