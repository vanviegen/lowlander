import * as E from "edinburgh";
import DataPack from "edinburgh/datapack";
import * as realWarpsocket from 'warpsocket';

// Get log level from environment variable
// 0: no logging (default)
// 1: connections & lifecycle (connect/disconnect/reconnect, worker startup)
// 2: RPC calls & responses (method calls, incoming responses, errors)
// 3: model streaming & internals (onSave, model changes, stream processing)
export const logLevel = parseInt(process.env.LOWLANDER_LOG_LEVEL || "0") || 0;

/** @internal Warpsocket implementation; swapped to FakeWarpSocket in test mode. */
export let warpsocket: typeof realWarpsocket = realWarpsocket;

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const WSHANDLER_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'wshandler.js');

/** @internal WarpSocket channel id prefix for model streams */
const CHANNEL_TYPE_MODEL = 1;

/** @internal Registry mapping model classes to their stream types */
const streamTypesPerModel: Map<ModelClass, typeof StreamTypeBase<unknown>[]> = new Map();

/** @internal Type alias for Edinburgh model classes */
type ModelClass = typeof E.Model<unknown>;

/**
 * Base class for stream types created by {@link createStreamType}.
 * @typeParam T - The projected model type
 * @internal
 */
export abstract class StreamTypeBase<T> {
    /** @internal */
    static fields: { [key: string]: true|number };
    /** @internal */
    static id: number;
    /** @internal */
    constructor(public _instance: E.Model<any> & T) {}

    toString() {
        let streamTypes = streamTypesPerModel.get(this._instance.constructor as ModelClass) || [];
        return `{Stream model=${this._instance.toString()} type=${streamTypes.indexOf(this.constructor as any)}}`;
    }
}

/**
 * Type-safe selector for specifying which model fields to stream to clients.
 * Use `true` to include a field, or an object to select nested fields in linked models.
 * 
 * @typeParam T - The model type
 */
type FieldSelection<T> =
  T extends ReadonlyArray<infer U>
    ? true | FieldSelection<U>
    : T extends Array<infer U>
      ? true | FieldSelection<U>
      : T extends object
        ? true | { [K in keyof T]?: FieldSelection<T[K]> }
        : true;

/**
 * Validates field selection compatibility at compile time.
 * @internal
 */
type ValidateSelection<T, S> =
  T extends ReadonlyArray<infer U>
    ? S extends true ? true : ValidateSelection<U, S>
    : T extends Array<infer U>
      ? S extends true ? true : ValidateSelection<U, S>
      : T extends object
        ? S extends true
          ? true
          : S extends object
            ? { [K in keyof S]-?: K extends keyof T ? ValidateSelection<T[K], S[K]> : never }
            : never
        : S extends true ? true : never;

/**
 * Computes the resulting type after applying a field selection.
 * @internal
 */
type Project<T, S> =
  S extends true
    ? T
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<Project<U, S>>
      : T extends Array<infer U>
        ? Array<Project<U, S>>
        : T extends object
          ? { [K in Extract<keyof S, keyof T>]: Project<T[K], S[K & keyof T]> }
          : T;


/**
 * Returns a stable numeric ID for a key tuple, allocating a new one if needed.
 * Safe for multiple WarpSocket threads.
 * @internal
 */
function getIdForData(namespace: string, ...data: any): number {
    const dataKeyPack = new DataPack().write(namespace);
    for(const d of data) dataKeyPack.write(d);
    const dataKey = dataKeyPack.toUint8Array();

    const idPack = warpsocket.getKey(dataKey);
    if (idPack) {
        return new DataPack(idPack).readNumber();
    }

    const countKey = new DataPack().write(namespace).toUint8Array();
    while(true) {
        // Insert a new stream type
        const countPack = warpsocket.getKey(countKey);
        const newCount = countPack ? new DataPack(countPack).readNumber() + 1 : 1;
        const newCountPack = new DataPack().write(newCount).toUint8Array();
        if (warpsocket.setKeyIf(countKey, newCountPack, countPack)) {
            if (warpsocket.setKeyIf(dataKey, newCountPack, undefined)) {
                return newCount; // Success
            }
        }
        // Raced, try again
    }
}

/**
 * Creates a stream type for reactive model streaming to clients with automatic updates.
 * 
 * Specify which fields to include; when they change, updates are pushed to subscribed clients.
 * Supports nested linked models and type-safe field selection.
 * 
 * @typeParam T - The model type
 * @typeParam S - The field selection
 * 
 * @param Model - The Edinburgh model class
 * @param selection - Field selection: `true` for simple fields, nested object for linked models
 * @returns Stream type class to instantiate in API functions
 * 
 * @example
 * ```ts
 * ⁣@E.registerModel
 * class Person extends Model {
 *   name = field(string);
 *   age = field(number);
 *   password = field(string);
 *   friends = field(array(link(Person)));
 * }
 * 
 * // Exclude password, include friends' names
 * const PersonStream = createStreamType(Person, {
 *   name: true,
 *   age: true,
 *   friends: { name: true }
 * });
 * 
 * export function streamPerson() {
 *   const person = Person.byName.get('Alice')!;
 *   return new PersonStream(person);
 * }
 * ```
 */
export function createStreamType<T, S extends FieldSelection<T>>(
  Model: ModelClass & (new (...args: any[]) => T),
  selection: S & ValidateSelection<T, S>
) {
    let streamTypes = streamTypesPerModel.get(Model);
    if (!streamTypes) streamTypesPerModel.set(Model, streamTypes = []);

    const streamTypeId = getIdForData("streamType", Model.tableName, selection);

    const fields: Record<string, true|number> = {};
    for(const prop of Array.from(Object.keys(selection)).sort() as (string & keyof S)[]) {
        if (!Model.fields.hasOwnProperty(prop)) {
            throw new Error(`Property ${prop} does not exist in model ${Model.name}`);
        }
        const LinkedModel = Model.fields[prop].type.getLinkedModel() as ModelClass | undefined;

        if (selection[prop] === true) {
            if (LinkedModel) throw new Error(`Property ${prop} is a link; must specify sub-selection`);
            fields[prop] = true; // Include field without tracking links
        } else {
            if (!LinkedModel) throw new Error(`Property ${prop} is not a link; cannot specify sub-selection`);
            const SubStreamType = createStreamType(LinkedModel as any, selection[prop] as any)
            fields[prop] = SubStreamType.id;
        }
    }
    class StreamType extends StreamTypeBase<Project<T, S>> {
        static fields = fields;
        static id = streamTypeId;
    }
    streamTypes.push(StreamType);
    return StreamType;
}

/** Writes `value` to `pack`, replacing Model instances with XOR'd hash refs. */
function writeModelField(pack: DataPack, value: any, streamTypeId: number): void {
    if (typeof value !== 'object' || value == null) {
        pack.write(value);
    } else if (value instanceof E.Model) {
        pack.writeCustom('model', value.getPrimaryKeyHash() + streamTypeId);
    } else if (Array.isArray(value)) {
        pack.writeCollection('array', () => {
            for (const item of value) writeModelField(pack, item, streamTypeId);
        });
    } else {
        pack.writeCollection('object', () => {
            for (const key of Object.keys(value)) {
                pack.write(key);
                writeModelField(pack, value[key], streamTypeId);
            }
        });
    }
}

/** Tracks link deltas for subscription management. */
function updateLinkDeltas(value: any, linkDeltas: Map<E.Model<unknown>, Map<number,number>>, streamTypeId: number, delta: number): void {
    if (typeof value !== 'object' || value == null) return;
    if (Array.isArray(value)) {
        for (const item of value) updateLinkDeltas(item, linkDeltas, streamTypeId, delta);
    } else if (value instanceof E.Model) {
        let map = linkDeltas.get(value);
        if (!map) linkDeltas.set(value, map = new Map());
        const v = (map.get(streamTypeId) || 0) + delta;
        if (v) map.set(streamTypeId, v);
        else map.delete(streamTypeId);
    } else {
        for (const key of Object.keys(value)) {
            updateLinkDeltas(value[key], linkDeltas, streamTypeId, delta);
        }
    }
}

E.setOnSaveCallback((commitId: number, items: Map<E.Model<any>, E.Change>) => {
    if (logLevel >= 3) console.log('[lowlander] onSave', commitId);
    for(const [model, changed] of items.entries()) {
        
        const streamTypes = streamTypesPerModel.get(model.constructor);
        if (logLevel >= 3) console.log('[lowlander] Model changed:', model, changed, `streams=${streamTypes?.length}`);
        if (!streamTypes) continue;

        for(const StreamType of streamTypes) {
            const channelName = DataPack.createUint8Array(CHANNEL_TYPE_MODEL, model.getPrimaryKeyHash() + StreamType.id);

            if (logLevel >= 3) console.log('[lowlander] Processing stream type', StreamType.name, 'channel', channelName);

            // Don't bother constructing a change message if nobody is listening
            if (!warpsocket.hasSubscriptions(channelName)) continue;

            // When an instance is first created, we can't possibly have any references to it yet, so we don't need to emit it.
            if (changed !== 'created') {
                sendModel(channelName, model, commitId, StreamType, changed);
            }
        }
    }
});


/**
 * Sends (updated) data for `model` to `target`.
 * `target` is a virtual socket with a requestId+'d' user prefix, or a channel that subscribes such virtual sockets.
 */
export function sendModel(target: Uint8Array | number | number[], model: E.Model<any>, commitId: number, StreamType: typeof StreamTypeBase<any>, changed?: E.Change) {
    let pack = new DataPack();
    pack.write(model.getPrimaryKeyHash()! + StreamType.id);
    pack.write(commitId);
    
    let mustSend = false;

    if (changed === 'deleted') {
        pack.write(null);
        mustSend = true;
    }
    else { // changed is an object or 'created'
        const linkDeltas = new Map<E.Model<unknown>, Map<number,number>>();

        pack.writeCollection('object', (addRecord) => {
            for(const fieldName in StreamType.fields) {
                if (typeof changed === 'object' && !changed.hasOwnProperty(fieldName)) continue;
                let streamIndex = StreamType.fields[fieldName];

                const fieldValue = (model as any)[fieldName];
                mustSend = true;
                
                if (typeof streamIndex === 'number') {
                    pack.write(fieldName);
                    writeModelField(pack, fieldValue, streamIndex);
                    updateLinkDeltas(fieldValue, linkDeltas, streamIndex, 1);
                    if (typeof changed === 'object') updateLinkDeltas(changed[fieldName], linkDeltas, streamIndex, -1);
                } else {
                    addRecord(fieldName, fieldValue);
                }
            }
        });

        for(const linkedModel of linkDeltas.keys()) {
            let streamIndexMap = linkDeltas.get(linkedModel)!;
            const subStreamTypes = streamTypesPerModel.get(linkedModel.constructor)!;
            for(const subStreamType of subStreamTypes) {
                const delta = streamIndexMap.get(subStreamType.id);
                if (delta) { // Only in case delta is set and non-zero
                    pushModel(target, linkedModel, commitId, subStreamType, delta);
                }
            }
        }
    }
    // else: Do nothing in case of changed=="created", as there can't be any subscribers yet at this time.

    // If at least one field was updated, send the packet
    if (mustSend) {
        warpsocket.send(target, pack.toUint8Array(false));
    }
}

/**
 * Subscribes `target` to this model, and sends initial data.
 * `target` is a virtual socket with a requestId+'d' user prefix, or a channel that subscribes such virtual sockets.
 */
export function pushModel(target: number | Uint8Array | number[], model: E.Model<any>, commitId: number, SubStreamType: typeof StreamTypeBase<any>, delta: number) {
    const subChannel = DataPack.createUint8Array(CHANNEL_TYPE_MODEL, model.getPrimaryKeyHash() + SubStreamType.id);

    let changedSocketIds = warpsocket.subscribe(target, subChannel, delta);
    if (changedSocketIds.length > 0) {
        sendModel(changedSocketIds, model, commitId, SubStreamType, delta > 0 ? 'created' : 'deleted');
    }
}

/**
 * Wraps a server-side API object to create a stateful, type-safe proxy accessible from clients.
 * Use for authentication, sessions, or any stateful context that persists across RPC calls.
 * 
 * @typeParam API - The server-side API object type
 * @typeParam RETURN - The value type returned to the client
 * 
 * @example
 * ```ts
 * export class UserAPI {
 *   constructor(public user: User) {}
 *   getSecret() { return this.user.secret; }
 * }
 * 
 * export async function authenticate(token: string) {
 *   const user = await validateToken(token);
 *   return new ServerProxy(new UserAPI(user), user.name);
 * }
 * 
 * // Client: auth.value is user name, auth.serverProxy.getSecret() calls UserAPI method
 * ```
 */
export class ServerProxy<API extends object, RETURN> {
    /**
     * @param api - Server-side API object exposed to the client
     * @param value - Value returned immediately to the client
     */
    constructor(public api: API, public value?: RETURN) {}
    toString() {
        return `{ServerProxy proxy=${this.api.constructor?.name} value=${this.value}}`;
    }
}

/**
 * Server-side socket for pushing data to a client. Server functions with `Socket<T>` parameters
 * receive client callbacks on the client side.
 * 
 * @typeParam T - Data type sent through the socket
 * 
 * @example
 * ```ts
 * // Server
 * export function streamNumbers(socket: Socket<number>) {
 *   setInterval(() => {
 *     if (!socket.send(Math.random())) clearInterval(interval);
 *   }, 1000);
 * }
 * 
 * // Client
 * api.streamNumbers(num => console.log(num));
 * ```
 */
export class Socket<T> {
    /** @internal */
    constructor(public virtualSocketId: number) {}

    /**
     * Sends data to the client.
     * @param data - Data to send (automatically serialized)
     * @returns `true` if sent, `false` if socket is closed
     */
    send(data: T) {
        const buffer = data instanceof Uint8Array ? data : new DataPack().write(data).toUint8Array();
        return warpsocket.send(this.virtualSocketId, buffer);
    }

    /** @internal */
    subscribe(channel: Uint8Array, delta=1) {
        if (!(channel instanceof Uint8Array)) {
            channel = new DataPack().write(channel).toUint8Array()
        }
        warpsocket.subscribe(this.virtualSocketId, channel, delta);
    }

    toString() {
        return `{Socket id=${this.virtualSocketId}}`;
    }

    [Symbol.for('nodejs.util.inspect.custom')]() {
        return this.toString();
    }
}

/**
 * Starts the Lowlander WebSocket server.
 * 
 * @param mainApiFile - Absolute path to the compiled API file exporting server functions
 * @param opts.bind - Address and port (default: '0.0.0.0:8080')
 * @param opts.threads - Worker thread count (default: auto)
 * @param opts.injectWarpSocket - For testing: inject a custom WarpSocket implementation (e.g. FakeWarpSocket)
 * 
 * @example
 * ```ts
 * import { start } from 'lowlander/server';
 * import { fileURLToPath } from 'url';
 * import { resolve, dirname } from 'path';
 * 
 * const API_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'api.js');
 * start(API_FILE, { bind: '0.0.0.0:8080' });
 * ```
 */
export async function start(mainApiFile: string, opts: {bind?: string, threads?: number, injectWarpSocket?: typeof realWarpsocket} = {}): Promise<void> {
    if (opts.injectWarpSocket) {
        warpsocket = opts.injectWarpSocket;
    }
    await warpsocket.start({
        bind: opts.bind || '0.0.0.0:8080',
        threads: opts.threads,
        workerPath: WSHANDLER_FILE,
        workerArg: mainApiFile,
    });
}
