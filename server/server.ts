import * as E from "edinburgh";
import DataPack from "edinburgh/datapack";
import * as warpsocket from 'warpsocket';

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
 * @internal
 */
function getIdForData(namespace: string, ...data: any): number {
    const dataKeyPack = new DataPack().write(namespace);
    for(const d of data) dataKeyPack.write(d);
    const dataKey = dataKeyPack.toUint8Array();

    const countKey = new DataPack().write(namespace).toUint8Array();

    while(true) {
        const idPack = warpsocket.getKey(dataKey);
        if (idPack) {
            return new DataPack(idPack).readNumber();
        }
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
 * @registerModel
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

function getLinks(newValue: any, modelMap: Map<E.Model<unknown>, Map<number,number>>, delta: number, streamIndex: number): void {
    if (typeof newValue !== 'object' || newValue == null) return;
    if (Array.isArray(newValue)) {
        for (const item of newValue) {
            getLinks(item, modelMap, delta, streamIndex);
        }
    } else if (newValue instanceof E.Model) {
        let streamIndexMap = modelMap.get(newValue);
        if (!streamIndexMap) modelMap.set(newValue, streamIndexMap = new Map());

        const v = (streamIndexMap.get(streamIndex) || 0) + delta;
        if (v) streamIndexMap.set(streamIndex, v);
        else streamIndexMap.delete(streamIndex);
    } else {
        for (const key of Object.keys(newValue)) {
            getLinks(newValue[key], modelMap, delta, streamIndex);
        }
    }
}

E.setOnSaveCallback((commitId: number, models: E.Model<any>[]) => {
    // TODO: do something with commitId, to resolve race conditions client-side
    for(const model of models) {
        const streamTypes = streamTypesPerModel.get(model.constructor);
        if (!streamTypes) continue;

        const changed = model.changed as Partial<E.Model<any>> | 'created' | 'deleted';

        for(const StreamType of streamTypes) {
            const channelName = DataPack.createUint8Array(CHANNEL_TYPE_MODEL, model.getPrimaryKeyHash()!, StreamType.id);

            // Don't bother constructing a change message if nobody is listening
            if (!warpsocket.hasSubscriptions(channelName)) continue;

            if (changed === 'created') {
                // Nothing needs to be done, as there can't be any subscribers yet. (?)
            } else if (changed === 'deleted') {
                sendDeleteModel(channelName, model, commitId);
            } else if (typeof changed === 'object') {
                sendModel(channelName, model, commitId, StreamType, changed);
            }
        }
    }
});



// Models should serialize as a custom 'model' type containing their primary key hash
declare module "edinburgh" {
    interface Model<SUB> {
        toDataPack(dataPack: DataPack): void;
    }
}
E.Model.prototype.toDataPack = function(this: E.Model<any>, dataPack: DataPack) {
    dataPack.writeCustom('model', this.getPrimaryKeyHash());
}


export function sendModel(target: Uint8Array | number | number[], model: E.Model<any>, commitId: number, StreamType: typeof StreamTypeBase<any>, changed?: Partial<E.Model<any>>) {
    let pack = new DataPack();
    pack.write(model.getPrimaryKeyHash()!);
    
    const linkDeltas = new Map<E.Model<unknown>, Map<number,number>>();
    let hasField = false;

    pack.writeCollection('object', (addRecord) => {
        for(const field of Object.keys(StreamType.fields)) {
            if (changed && changed.hasOwnProperty(field)) continue;
            let streamIndex = StreamType.fields[field];

            const n = (model as any)[field];
            addRecord(field, n);
            hasField = true;
            
            if (typeof streamIndex === 'number') {
                getLinks(n, linkDeltas, 1, streamIndex);
                if (changed) getLinks((changed as any)[field], linkDeltas, -1, streamIndex);
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

    // If at least one field was updated, send the packet
    if (hasField) {
        warpsocket.send(target, pack.toUint8Array(false));
    }
}

export function pushModel(target: number | Uint8Array | number[], model: E.Model<any>, commitId: number, SubStreamType: typeof StreamTypeBase<any>, delta: number) {
    const subChannel = DataPack.createUint8Array(CHANNEL_TYPE_MODEL, model.getPrimaryKeyHash()!, SubStreamType.id);

    let changedSocketIds = warpsocket.subscribe(target, subChannel, delta);
    if (changedSocketIds.length > 0) {
        if (delta > 0) {
            sendModel(changedSocketIds, model, commitId, SubStreamType);
        } else {
            sendDeleteModel(changedSocketIds, model, commitId);
        }
    }
}

function sendDeleteModel(target: number | Uint8Array | number[], model: E.Model<any>, _commitId: number) {
    warpsocket.send(target, DataPack.createBuffer(model.getPrimaryKey(), null));
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
    constructor(public api: API, public value: RETURN) {}
    toString() {
        return `{ServerProxy proxy=${this.api.constructor.name} value=${this.value}}`;
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
export function start(mainApiFile: string, opts: {bind?: string, threads?: number} = {}) {
    warpsocket.start({
        bind: opts.bind || '0.0.0.0:8080',
        threads: opts.threads,
        workerPath: WSHANDLER_FILE,
        workerArg: mainApiFile,
    });
}
