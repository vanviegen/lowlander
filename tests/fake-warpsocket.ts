/**
 * In-process fake implementation of warpsocket for testing.
 * 
 * Provides the full warpsocket API (send, subscribe, virtual sockets, KV store)
 * backed by in-memory data structures. Message delivery uses setTimeout(fn, 0)
 * so it integrates with Aberdeen's fakedom passTime().
 */
import * as pathMod from 'node:path';

import type { WorkerInterface } from 'warpsocket';
let workerModule: WorkerInterface;

interface VirtualSocket {
    targetSocketId: number;
    userPrefix?: Uint8Array;
}

interface FakeClientSocket {
    socketId: number;
    onmessage?: ((event: {data: ArrayBuffer}) => void) | null;
    onopen?: (() => void) | null;
    onclose?: (() => void) | null;
    onerror?: ((error: any) => void) | null;
    readyState: number;
    binaryType: string;
    send(data: Uint8Array | ArrayBuffer): void;
    close(): void;
}

type ChannelDebug = { channel: Uint8Array, subscribers: { [socketId: number]: number } };
type SocketDebug = { ip: string, workerId: number } | { targetSocketId: number, userPrefix?: Uint8Array };
type WorkerDebug = { hasTextHandler: boolean, hasBinaryHandler: boolean, hasCloseHandler: boolean, hasOpenHandler: boolean };
type KVDebug = { key: Uint8Array, value: Uint8Array };

let nextSocketId = 1;
let nextVirtualSocketId = 100000; // High range to avoid collisions
let virtualSockets = new Map<number, VirtualSocket>();
let channels = new Map<string, Map<number, number>>(); // channelKey -> socketId -> refCount
let channelBytes = new Map<string, Uint8Array>(); // channelKey -> original channel name bytes
let kv = new Map<string, Uint8Array>();
let kvKeyBytes = new Map<string, Uint8Array>(); // keyStr -> original key bytes
let clientSockets = new Map<number, FakeClientSocket>();

/** Convert any accepted type to Uint8Array */
function toBytes(input: Uint8Array | ArrayBuffer | string): Uint8Array {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    return new TextEncoder().encode(input);
}

function keyStr(key: Uint8Array | ArrayBuffer | string): string {
    if (typeof key === 'string') return key;
    const bytes = key instanceof Uint8Array ? key : new Uint8Array(key);
    return Array.from(bytes).join(',');
}

function channelKey(name: Uint8Array | ArrayBuffer | string): string {
    return 'ch:' + keyStr(name);
}

export function send(target: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], data: Uint8Array | ArrayBuffer | string): number {
    const buf = toBytes(data);

    if (typeof target === 'number') {
        return sendToSocket(target, buf);
    } else if (typeof target === 'string' || target instanceof Uint8Array || target instanceof ArrayBuffer) {
        return sendToChannel(target, buf);
    } else if (Array.isArray(target)) {
        let count = 0;
        for (const item of target) {
            if (typeof item === 'number') {
                count += sendToSocket(item, buf);
            } else {
                count += sendToChannel(item, buf);
            }
        }
        return count;
    }
    return 0;
}

function sendToSocket(id: number, data: Uint8Array): number {
    const vs = virtualSockets.get(id);
    if (vs) {
        let finalData: Uint8Array;
        if (vs.userPrefix) {
            finalData = new Uint8Array(vs.userPrefix.length + data.length);
            finalData.set(vs.userPrefix, 0);
            finalData.set(data, vs.userPrefix.length);
        } else {
            finalData = data;
        }
        return sendToSocket(vs.targetSocketId, finalData);
    }

    const client = clientSockets.get(id);
    if (!client || client.readyState !== 1) return 0;
    
    const copy = new Uint8Array(data).slice();
    setTimeout(() => {
        if (client.readyState === 1 && client.onmessage) {
            client.onmessage({data: copy.buffer});
        }
    }, 0);
    return 1;
}

function sendToChannel(channelName: Uint8Array | ArrayBuffer | string, data: Uint8Array): number {
    const key = channelKey(channelName);
    const subscribers = channels.get(key);
    if (!subscribers) return 0;
    let count = 0;
    for (const vsId of subscribers.keys()) {
        count += sendToSocket(vsId, data);
    }
    return count;
}

/** 
* Subscribes one or more WebSocket connections to a channel, or copies subscriptions from one channel to another.
* Multiple subscriptions to the same channel by the same connection are reference-counted.
* 
* @param socketIdOrChannelName - Can be:
*   - A single socket ID (number): applies delta to that socket's subscription
*   - An array of socket IDs (number[]): applies delta to all sockets' subscriptions
*   - A channel name (Buffer/ArrayBuffer/string): applies delta to all subscribers of this source channel
*   - An array mixing socket IDs and channel names: applies delta to sockets and source channel subscribers
* @param channelName - The target channel name (Buffer, ArrayBuffer, or string).
* @param delta - Optional. The amount to change the subscription count by (default: 1). 
*   Positive values add subscriptions, negative values remove them. When the count reaches zero, the subscription is removed.
* @returns An array of socket IDs that were affected by the operation:
*   - For positive delta: socket IDs that became newly subscribed (reference count went from 0 to positive)
*   - For negative delta: socket IDs that became completely unsubscribed (reference count reached 0)
*/
export function subscribe(target: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], channelName: Uint8Array | ArrayBuffer | string, delta: number = 1): number[] {
    const key = channelKey(channelName);
    let subscribers = channels.get(key);
    if (!subscribers) {
        channels.set(key, subscribers = new Map());
        channelBytes.set(key, toBytes(channelName));
    }

    // Resolve targets to socket IDs
    let socketIds: number[];
    if (typeof target === 'number') {
        socketIds = [target];
    } else if (Array.isArray(target)) {
        socketIds = [];
        for (const item of target) {
            if (typeof item === 'number') {
                socketIds.push(item);
            } else {
                // Channel name — gather its subscribers
                const srcSubs = channels.get(channelKey(item));
                if (srcSubs) for (const sid of srcSubs.keys()) socketIds.push(sid);
            }
        }
    } else {
        // target is a channel name (Uint8Array | ArrayBuffer | string)
        const srcSubs = channels.get(channelKey(target));
        socketIds = srcSubs ? [...srcSubs.keys()] : [];
    }

    const changed: number[] = [];
    for (const sid of socketIds) {
        const current = subscribers.get(sid) || 0;
        const next = current + delta;
        if (delta > 0) {
            subscribers.set(sid, next);
            if (current === 0) changed.push(sid);
        } else {
            if (next <= 0) {
                subscribers.delete(sid);
                if (current > 0) changed.push(sid);
            } else {
                subscribers.set(sid, next);
            }
        }
    }
    if (!subscribers.size) {
        channels.delete(key);
        channelBytes.delete(key);
    }
    return changed;
}

/**
 * Exactly the same as `subscribe`, only with a negative delta (defaulting to 1, which means a single unsubscribe, or a subscribe with delta -1).
 */
export function unsubscribe(socketIdOrChannelName: number | number[] | Uint8Array | ArrayBuffer | string | (number | Uint8Array | ArrayBuffer | string)[], channelName: Uint8Array | ArrayBuffer | string, delta: number = 1): number[] {
    return subscribe(socketIdOrChannelName, channelName, -delta);
}

/** 
* **DEPRECATED:** Use subscribe(fromChannelName, toChannelName) instead.
* 
* Copies all subscribers from one channel to another channel. Uses reference counting - if a subscriber 
* is already subscribed to the destination channel, their reference count will be incremented instead 
* of creating duplicate subscriptions.
* @param fromChannelName - The source channel name (Buffer, ArrayBuffer, or string).
* @param toChannelName - The destination channel name (Buffer, ArrayBuffer, or string).
* @returns An array of socket IDs that were newly added to the destination channel. Sockets that were 
*   already subscribed (and had their reference count incremented) are not included.
*/
export function copySubscriptions(fromChannelName: Uint8Array | ArrayBuffer | string, toChannelName: Uint8Array | ArrayBuffer | string): number[] {
    return subscribe(fromChannelName, toChannelName);
}
 
export function hasSubscriptions(channelName: Uint8Array | ArrayBuffer | string): boolean {
    const key = channelKey(channelName);
    const subscribers = channels.get(key);
    return !!subscribers && subscribers.size > 0;
}

export function createVirtualSocket(socketId: number, userPrefix?: Uint8Array | ArrayBuffer | string): number {
    const vsId = nextVirtualSocketId++;
    virtualSockets.set(vsId, {
        targetSocketId: socketId,
        userPrefix: userPrefix != null ? toBytes(userPrefix) : undefined,
    });
    return vsId;
}

export function deleteVirtualSocket(virtualSocketId: number, expectedTargetSocketId?: number): boolean {
    const vs = virtualSockets.get(virtualSocketId);
    if (!vs) return false;
    if (expectedTargetSocketId !== undefined && vs.targetSocketId !== expectedTargetSocketId) return false;
    virtualSockets.delete(virtualSocketId);
    // Unsubscribe from all channels
    for (const [key, subscribers] of channels) {
        subscribers.delete(virtualSocketId);
        if (!subscribers.size) {
            channels.delete(key);
            channelBytes.delete(key);
        }
    }
    return true;
}

export function getKey(key: Uint8Array | ArrayBuffer | string): Uint8Array | undefined {
    return kv.get(keyStr(key));
}

export function setKey(key: Uint8Array | ArrayBuffer | string, value?: Uint8Array | ArrayBuffer | string): Uint8Array | undefined {
    const k = keyStr(key);
    const prev = kv.get(k);
    if (value == null) {
        kv.delete(k);
        kvKeyBytes.delete(k);
    } else {
        kv.set(k, toBytes(value));
        if (!kvKeyBytes.has(k)) kvKeyBytes.set(k, toBytes(key));
    }
    return prev;
}

export function setKeyIf(key: Uint8Array | ArrayBuffer | string, newValue?: Uint8Array | ArrayBuffer | string, checkValue?: Uint8Array | ArrayBuffer | string): boolean {
    const k = keyStr(key);
    const current = kv.get(k);
    const checkBytes = checkValue != null ? toBytes(checkValue) : undefined;
    // Compare: both undefined, or byte-equal
    const matches = (current === undefined && checkBytes === undefined) || (
        current !== undefined && checkBytes !== undefined &&
        current.length === checkBytes.length &&
        current.every((v, i) => v === checkBytes[i])
    );
    if (!matches) return false;
    if (newValue == null) {
        kv.delete(k);
        kvKeyBytes.delete(k);
    } else {
        kv.set(k, toBytes(newValue));
        if (!kvKeyBytes.has(k)) kvKeyBytes.set(k, toBytes(key));
    }
    return true;
}

export function getDebugState(mode: "channels"): ChannelDebug[];
export function getDebugState(mode: "channels", channelName: Uint8Array | ArrayBuffer | string): ChannelDebug | undefined;
export function getDebugState(mode: "channels", filterSocketId: number): ChannelDebug[];
export function getDebugState(mode: "sockets"): Record<number, SocketDebug>;
export function getDebugState(mode: "sockets", socketId: number): SocketDebug | undefined;
export function getDebugState(mode: "workers"): Record<number, WorkerDebug>;
export function getDebugState(mode: "workers", workerId: number): WorkerDebug | undefined;
export function getDebugState(mode: "kv"): KVDebug[];
export function getDebugState(mode: string, singleKey?: any): any {
    if (mode === 'channels') {
        if (singleKey !== undefined) {
            if (typeof singleKey === 'number') {
                // Filter: all channels this socket is subscribed to
                const result: ChannelDebug[] = [];
                for (const [key, subscribers] of channels) {
                    if (subscribers.has(singleKey)) {
                        const subs: { [id: number]: number } = {};
                        for (const [sid, count] of subscribers) subs[sid] = count;
                        result.push({ channel: channelBytes.get(key)!, subscribers: subs });
                    }
                }
                return result;
            } else {
                // Lookup single channel by name
                const key = channelKey(singleKey);
                const subscribers = channels.get(key);
                if (!subscribers) return undefined;
                const subs: { [id: number]: number } = {};
                for (const [sid, count] of subscribers) subs[sid] = count;
                return { channel: channelBytes.get(key)!, subscribers: subs } as ChannelDebug;
            }
        }
        const result: ChannelDebug[] = [];
        for (const [key, subscribers] of channels) {
            const subs: { [id: number]: number } = {};
            for (const [sid, count] of subscribers) subs[sid] = count;
            result.push({ channel: channelBytes.get(key)!, subscribers: subs });
        }
        return result;
    }
    if (mode === 'sockets') {
        if (typeof singleKey === 'number') {
            const vs = virtualSockets.get(singleKey);
            if (vs) {
                const debug: any = { targetSocketId: vs.targetSocketId };
                if (vs.userPrefix) debug.userPrefix = vs.userPrefix;
                return debug as SocketDebug;
            }
            const cs = clientSockets.get(singleKey);
            if (cs) return { ip: '127.0.0.1', workerId: 0 } as SocketDebug;
            return undefined;
        }
        const result: Record<number, SocketDebug> = {};
        for (const [id] of clientSockets) {
            result[id] = { ip: '127.0.0.1', workerId: 0 };
        }
        for (const [id, vs] of virtualSockets) {
            const debug: any = { targetSocketId: vs.targetSocketId };
            if (vs.userPrefix) debug.userPrefix = vs.userPrefix;
            result[id] = debug;
        }
        return result;
    }
    if (mode === 'workers') {
        const info: WorkerDebug = {
            hasTextHandler: !!workerModule?.handleTextMessage,
            hasBinaryHandler: !!workerModule?.handleBinaryMessage,
            hasCloseHandler: !!workerModule?.handleClose,
            hasOpenHandler: !!workerModule?.handleOpen,
        };
        if (typeof singleKey === 'number') return singleKey === 0 ? info : undefined;
        return { 0: info } as Record<number, WorkerDebug>;
    }
    if (mode === 'kv') {
        const result: KVDebug[] = [];
        for (const [k, v] of kv) {
            result.push({ key: kvKeyBytes.get(k) || toBytes(k), value: v });
        }
        return result;
    }
    return {};
}

/** Create a fake client-side WebSocket that's wired to this in-process server. */
export function createClientSocket(): WebSocket {
    const socketId = nextSocketId++;

    // Serialize message processing per socket (like real warpsocket)
    let messageQueue: Promise<void> = Promise.resolve();

    const socket: FakeClientSocket = {
        socketId,
        onmessage: null,
        onopen: null,
        onclose: null,
        onerror: null,
        readyState: 0, // CONNECTING
        binaryType: 'arraybuffer',

        send(data: Uint8Array | ArrayBuffer) {
            const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
            // Queue message processing to ensure sequential handling
            messageQueue = messageQueue.then(() => new Promise<void>(resolve => {
                setTimeout(async () => {
                    try {
                        await workerModule.handleBinaryMessage?.(buf, socketId);
                    } catch (e) {
                        console.error('FakeWarpSocket: handleBinaryMessage error', e);
                    }
                    resolve();
                }, 0);
            }));
        },

        close() {
            if (socket.readyState >= 2) return;
            socket.readyState = 2; // CLOSING
            clientSockets.delete(socketId);
            messageQueue = messageQueue.then(() => new Promise<void>(resolve => {
                setTimeout(async () => {
                    socket.readyState = 3; // CLOSED
                    await workerModule.handleClose?.(socketId);
                    socket.onclose?.();
                    resolve();
                }, 0);
            }));
        },
    };

    clientSockets.set(socketId, socket);

    // Open asynchronously
    setTimeout(() => {
        socket.readyState = 1; // OPEN
        workerModule.handleOpen?.(socketId, '127.0.0.1', {"user-agent": "FakeWarpSocket"});
        socket.onopen?.();
    }, 0);

    return socket as any;
}

/** Reset all state (for between tests). */
export function reset() {
    for (const client of clientSockets.values()) {
        client.readyState = 3;
    }
    clientSockets.clear();
    virtualSockets.clear();
    channels.clear();
    channelBytes.clear();
    kv.clear();
    kvKeyBytes.clear();
    nextSocketId = 1;
    nextVirtualSocketId = 100000;
}

/**
 * Initializes the fake warpsocket. Ignores `threads` and `bind`.
 */

export async function start(options: {
    bind: string | string[];
    workerPath?: string;
    threads?: number;
    workerArg?: any;
}): Promise<void> {
    if (!options || !options.bind || !options.workerPath) {
        throw new Error('options.bind and options.workerPath are required');
    }

    if (!pathMod.isAbsolute(options.workerPath)) {
        options.workerPath = pathMod.resolve(process.cwd(), options.workerPath);
    }

    workerModule = await import(options.workerPath);
    await workerModule.handleStart?.(options.workerArg);
}

