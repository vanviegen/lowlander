# Lowlander

An **experimental** TypeScript framework for data persistence and (partial) client synchronization.

This project is still under heavy development. **DO NOT USE** for anything serious. Early feedback is very welcome though!

To get an impression of what use of this framework currently looks like, check out the example project's...

 - [server-side API](examples/helloworld/server/api.ts) and
 - [client-side UI](examples/helloworld/client/js/base.ts) code.

## Tech

This library is built on top of a number of libraries by the same author:

- [Edinburgh](https://github.com/vanviegen/edinburgh): use JavaScript objects as really fast ACID database records.
- [OLMDB](https://github.com/vanviegen/olmdb): a very fast on-disk key/value store with MVCC and optimistic transactions, used by Edinburgh for persistence.
- [WarpSocket](https://github.com/vanviegen/warpsocket): a high-performance WebSocket server written in Rust, that coordinates multiple JavaScript worker threads and provides an API for channel subscriptions.
- [Aberdeen](https://github.com/vanviegen/aberdeen): a reactive UI library for JavaScript. It features fine-grained updates, needs no virtual DOM, and uses Proxy for reactivity.

Lowlander glues these together and adds real-time partial data synchronization and type-safe RPCs to provide a framework for rapidly building performant full-stack (database included!) web applications.

## Logging

You can enable debug logging to stdout by setting the `LOWLANDER_LOG_LEVEL` environment variable to a number from 0 to 3. Higher numbers produce more verbose logs, including model-level operations, updates, and reads.

- 0: no logging (default)
- 1: connections & lifecycle
- 2: RPC calls & responses
- 3: model streaming & internals

You can set a similar `EDINBURGH_LOG_LEVEL` variable to enable logging from the underlying Edinburgh library, which Lowlander uses for data management and synchronization.

## Server API Reference

The following is auto-generated from `server/server.ts`:

### createStreamType · [function](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L162)

Creates a stream type for reactive model streaming to clients with automatic updates.

Specify which fields to include; when they change, updates are pushed to subscribed clients.
Supports nested linked models and type-safe field selection.

**Signature:** `<T, S extends FieldSelection<T>>(Model: typeof E.Model<unknown> & (new (...args: any[]) => T), selection: S & ValidateSelection<T, S>) => typeof StreamType`

**Type Parameters:**

- `T`
- `S extends FieldSelection<T>`

**Parameters:**

- `Model: ModelClass & (new (...args: any[]) => T)` - - The Edinburgh model class
- `selection: S & ValidateSelection<T, S>` - - Field selection: `true` for simple fields, nested object for linked models

**Returns:** Stream type class to instantiate in API functions

**Examples:**

```ts

### sendModel · [function](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L262)

Sends (updated) data for `model` to `target`.
`target` is a virtual socket with a requestId+'d' user prefix, or a channel that subscribes such virtual sockets.

**Signature:** `(target: number | Uint8Array<ArrayBufferLike> | number[], model: Model<any>, commitId: number, StreamType: typeof StreamTypeBase<any>, changed?: Change) => void`

**Parameters:**

- `target: Uint8Array | number | number[]`
- `model: E.Model<any>`
- `commitId: number`
- `StreamType: typeof StreamTypeBase<any>`
- `changed?: E.Change`

### pushModel · [function](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L318)

Subscribes `target` to this model, and sends initial data.
`target` is a virtual socket with a requestId+'d' user prefix, or a channel that subscribes such virtual sockets.

**Signature:** `(target: number | Uint8Array<ArrayBufferLike> | number[], model: Model<any>, commitId: number, SubStreamType: typeof StreamTypeBase<any>, delta: number) => void`

**Parameters:**

- `target: number | Uint8Array | number[]`
- `model: E.Model<any>`
- `commitId: number`
- `SubStreamType: typeof StreamTypeBase<any>`
- `delta: number`

### start · [function](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L427)

Starts the Lowlander WebSocket server.

**Signature:** `(mainApiFile: string, opts?: { bind?: string; threads?: number; injectWarpSocket?: typeof import("/var/home/frank/projects/warpsocket/dist/src/index", { with: { "resolution-mode": "import" } }); }) => Promise<void>`

**Parameters:**

- `mainApiFile: string` - - Absolute path to the compiled API file exporting server functions
- `opts: {bind?: string, threads?: number, injectWarpSocket?: typeof realWarpsocket}` (optional)

**Examples:**

```ts
import { start } from 'lowlander/server';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const API_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'api.js');
start(API_FILE, { bind: '0.0.0.0:8080' });
```

### logLevel · [constant](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L10)

**Value:** `number`

### warpsocket · [class](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L13)

**Type:** `typeof import("/var/home/frank/projects/warpsocket/dist/src/index", { with: { "resolution-mode": "import" } })`

### StreamTypeBase · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L34)

[object Object],[object Object],[object Object]

**Type Parameters:**

- `T`

#### StreamTypeBase.fields · [static property](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L36)

**Type:** `{ [key: string]: number | true; }`

#### StreamTypeBase.id · [static property](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L38)

**Type:** `number`

#### streamTypeBase.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L42)

**Signature:** `() => string`

**Parameters:**


### ServerProxy · [class](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L349)

Wraps a server-side API object to create a stateful, type-safe proxy accessible from clients.
Use for authentication, sessions, or any stateful context that persists across RPC calls.

**Type Parameters:**

- `API extends object`
- `RETURN`

**Examples:**

```ts
export class UserAPI {
  constructor(public user: User) {}
  getSecret() { return this.user.secret; }
}

export async function authenticate(token: string) {
  const user = await validateToken(token);
  return new ServerProxy(new UserAPI(user), user.name);
}

// Client: auth.value is user name, auth.serverProxy.getSecret() calls UserAPI method
```

**Constructor Parameters:**

- `api`: - Server-side API object exposed to the client
- `value`: - Value returned immediately to the client

#### serverProxy.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L355)

**Signature:** `() => string`

**Parameters:**


### Socket · [class](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L379)

Server-side socket for pushing data to a client. Server functions with `Socket<T>` parameters
receive client callbacks on the client side.

**Type Parameters:**

- `T`

**Examples:**

```ts
// Server
export function streamNumbers(socket: Socket<number>) {
  setInterval(() => {
    if (!socket.send(Math.random())) clearInterval(interval);
  }, 1000);
}

// Client
api.streamNumbers(num => console.log(num));
```

#### socket.send · [method](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L388)

Sends data to the client.

**Signature:** `(data: T) => number`

**Parameters:**

- `data: T` - - Data to send (automatically serialized)

**Returns:** `true` if sent, `false` if socket is closed

#### socket.subscribe · [method](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L394)

**Signature:** `(channel: Uint8Array<ArrayBufferLike>, delta?: number) => void`

**Parameters:**

- `channel: Uint8Array`
- `delta: any` (optional)

#### socket.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L401)

**Signature:** `() => string`

**Parameters:**


#### socket.[Symbol.for('nodejs.util.inspect.custom')] · [method](https://github.com/vanviegen/edinburgh/blob/main/server/server.ts#L405)

**Signature:** `() => string`

**Parameters:**


## Client API Reference

The following is auto-generated from `client/client.ts`:

### logLevel · [variable](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L8)

Set to 1-3 for increasing verbosity.

**Value:** `number`

### ClientProxyObject · [type](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L157)

Transforms server-side API objects to client-side proxy objects with type-safe RPC methods.

**Type:** `{
    [K in keyof T]: ClientProxyFunction<T[K]>
}`

### Connection · [class](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L190)

WebSocket connection to a Lowlander server with type-safe RPC, automatic reconnection,
and reactive updates.

**Type Parameters:**

- `T`

**Examples:**

```ts
import type * as API from './server/api.js';
const conn = new Connection<typeof API>('ws://localhost:8080/');

// Simple RPC - returns PromiseProxy
const sum = conn.api.add(1, 2);

// Server proxy for stateful APIs
const auth = conn.api.authenticate('token');
const secret = auth.serverProxy.getSecret();

// Streaming with callbacks
conn.api.streamData(data => console.log(data));

// Use within Aberdeen reactive scopes
$(() => {
  dump(conn.isOnline());
  dump(sum);
});
```

**Constructor Parameters:**

- `url`: - WebSocket URL (e.g., 'ws://localhost:8080/'), or a fake WebSocket object for testing

#### connection.ws · [property](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L192)

**Type:** `WebSocket`

#### connection.activeRequests · [property](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L193)

**Type:** `Map<number, ActiveRequest>`

#### connection.requestCounter · [property](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L194)

**Type:** `number`

#### connection.reconnectAttempts · [property](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L195)

**Type:** `number`

#### connection.onlineProxy · [property](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L198)

**Type:** `ValueRef<boolean>`

#### connection.api · [property](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L205)

Type-safe proxy to the server-side API. Methods return `PromiseProxy` objects
that work reactively in Aberdeen scopes. `ServerProxy` returns include a
`.serverProxy` property for accessing stateful server APIs.

**Type:** `ClientProxyObject<T>`

#### connection.isOnline · [method](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L218)

Returns the current connection status. Reactive in Aberdeen scopes.

**Signature:** `() => boolean`

**Parameters:**


#### connection.connect · [method](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L220)

**Signature:** `() => void`

**Parameters:**


#### connection.reconnect · [method](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L374)

**Signature:** `() => void`

**Parameters:**


#### connection.pruneCommitIds · [method](https://github.com/vanviegen/edinburgh/blob/main/client/client.ts#L388)

**Signature:** `(request: ActiveRequest, maxCommitId: number) => void`

**Parameters:**

- `request: ActiveRequest`
- `maxCommitId: number`

