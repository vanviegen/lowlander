# Lowlander

An **experimental** TypeScript framework for data persistence and (partial) client synchronization.

This project is still under heavy development. **DO NOT USE** for anything serious. Early feedback is very welcome though!

To get an impression of what use of this framework currently looks like, check out the example project's...

 - [server-side API](https://github.com/vanviegen/lowlander/blob/main/examples/helloworld/server/api.ts) and
 - [client-side UI](https://github.com/vanviegen/lowlander/blob/main/examples/helloworld/client/js/base.ts) code.

## Tech

This library is built on top of a number of libraries by the same author:

- [Edinburgh](https://github.com/vanviegen/edinburgh): use JavaScript objects as really fast ACID database records.
- [OLMDB](https://github.com/vanviegen/olmdb): a very fast on-disk key/value store with MVCC and optimistic transactions, used by Edinburgh for persistence.
- [WarpSocket](https://github.com/vanviegen/warpsocket): a high-performance WebSocket server written in Rust, that coordinates multiple JavaScript worker threads and provides an API for channel subscriptions.
- [Aberdeen](https://github.com/vanviegen/aberdeen): a reactive UI library for JavaScript. It features fine-grained updates, needs no virtual DOM, and uses Proxy for reactivity.

Lowlander glues these together and adds real-time partial data synchronization and type-safe RPCs to provide a framework for rapidly building performant full-stack (database included!) web applications.

## Tutorial

### Project Setup

```bash
bun init
bun add lowlander aberdeen edinburgh
```

(npm should also work for all of this.)

Create the project structure:

```
server/
  main.ts     # starts the server
  api.ts      # exported functions = RPC endpoints
client/
  app.ts      # UI using Aberdeen + Connection
```

If you use Claude Code, GitHub Copilot or another AI agent that supports Skills, Lowlander and its dependencies include `skill/` directories that provide specialized knowledge to the AI.

Symlink them into your project's `.claude/skills` directory:

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/lowlander/skill .claude/skills/lowlander
ln -s ../../node_modules/aberdeen/skill .claude/skills/aberdeen
ln -s ../../node_modules/edinburgh/skill .claude/skills/edinburgh
```

### Server Entry Point

The entry point starts the WarpSocket server and points it at the API file:

```ts
// server/main.ts
import { start } from 'lowlander/server';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const API_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'api.js');
start(API_FILE, { bind: '0.0.0.0:8080' });
```

Options: `bind` (address:port), `threads` (worker count).

### Defining RPC Endpoints

Every exported function in the API file is callable from the client. No decorators or registration needed:

```ts
// server/api.ts
export function add(a: number, b: number): number {
    return a + b;
}
```

Functions can be `async`. Thrown errors are sent to the client as error responses.

### Edinburgh Models

Define persistent data models using Edinburgh. See [Edinburgh docs](https://github.com/vanviegen/edinburgh) for full details.

```ts
import * as E from 'edinburgh';

@E.registerModel
class Person extends E.Model<Person> {
    static byName = E.primary(Person, 'name');
    name = E.field(E.string);
    age = E.field(E.number);
    friends = E.field(E.array(E.link(Person)));
    password = E.field(E.string);
}
```

Models are ACID, and RPC calls automatically run in transactions. When creating a `new Instance()` or updating props on an existing instance, changes are persisted to disk automatically. `E.link` objects are lazy-loaded.

### Model Streaming with `createStreamType`

Stream a subset of model fields to clients with real-time updates. Changes are pushed automatically. First you need to create a stream type, by doing this once:

```ts
import { createStreamType } from 'lowlander/server';

// Exclude password; include friends' names and ages
const PersonStream = createStreamType(Person, {
    name: true,
    age: true,
    friends: {        // nested linked model: specify sub-selection
        name: true,
        age: true,
    }
});
```

Use `true` for plain fields. For linked model fields, provide a nested selection object. To return a stream instance from an API function:

```ts
export function streamPerson(name: string) {
    const person = Person.byName.get(name)!;
    return new PersonStream(person);
}
```

On the client, this returns a reactive Aberdeen proxy that updates live when server data changes.

### ServerProxy for Stateful APIs

Wrap a class instance to expose per-connection stateful methods:

```ts
import { ServerProxy } from 'lowlander/server';

class UserAPI {
    constructor(public userName: string) {}
    
    get user(): Person {
        return Person.byName.get(this.userName)!;
    }

    getBio() {
        return `${this.user.name} is ${this.user.age} years old`;
    }
}

export async function authenticate(token: string) {
    const user = Person.byName.get(token);
    if (!user) throw new Error('User not found');
    return new ServerProxy(new UserAPI(token), 'secret-value');
}
```

The client receives `'secret-value'` as `.value` and can call `UserAPI` methods via `.serverProxy`.

### Socket Callbacks

Use `Socket<T>` parameters for server-push streaming. On the client, these become callback functions:

```ts
import { Socket } from 'lowlander/server';

export function streamNumbers(socket: Socket<number>) {
    const interval = setInterval(() => {
        if (!socket.send(Math.random())) clearInterval(interval);
    }, 1000);
}
```

`socket.send()` returns falsy when the client disconnects.

### Client Connection

Connect to the server with full type safety:

```ts
import { Connection } from 'lowlander/client';
import type * as API from './server/api.js';

const conn = new Connection<typeof API>('ws://localhost:8080/');
const api = conn.api;
```

All server exports are available on `conn.api` with matching types, except `Socket<T>` params become callbacks.

#### Simple RPC

```ts
const sum = api.add(1, 2);
// sum is a PromiseProxy:
// - sum.value starts out as undefined, and reactively updates to the result when available
// - sum.error is an Error object if the call threw, or undefined otherwise
// - sum.promise can be awaited: `const val = await sum.promise;` - this throws on error
```

#### Using ServerProxy

```ts
const auth = api.authenticate('Frank');
// auth.value → 'secret-value' (after resolution)
// auth.serverProxy → typed proxy to UserAPI methods

const bio = auth.serverProxy.getBio();
// bio.value → "Frank is 45 years old"
```

The server proxy is usable immediately—calls queue until authentication completes. If auth fails, queued calls fail too.

#### Model Streaming

```ts
const person = api.streamPerson('Alice');
// person.value is a reactive proxy that auto-updates
```

#### Socket Callbacks

```ts
api.streamNumbers(num => console.log(num));
```

On the server-side we should have a `export function streamNumbers(socket: Socket<number>)`.

#### Reactive Integration with Aberdeen

`PromiseProxy` results are reactive in Aberdeen scopes:

```ts
import A from 'aberdeen';

const sum = api.add(1, 2);
A(() => {
    if (sum.busy) A('span#Loading...');
    else if (sum.error) A('span#Error: ' + sum.error.message);
    else A('span#Result: ' + sum.value);
});
```

Model streams are also reactive—nested data updates trigger fine-grained UI updates:

```ts
const model = api.streamModel();
A(() => {
    if (!model.value) return;
    A('h2#' + model.value.name);
    A('p#Owner: ' + model.value.owner.name);
});
```

#### Connection Status

```ts
A(() => {
    A('span#' + (conn.isOnline() ? 'Connected' : 'Offline'));
});
```

Reconnection is automatic with exponential backoff.

#### Cleanup

Aberdeen's `clean()` handles RPC lifecycle. When a reactive scope is destroyed, active requests and subscriptions are cancelled automatically.

### Logging

Set the `LOWLANDER_LOG_LEVEL` environment variable to a number from 0 to 3:

- 0: no logging (default)
- 1: connections & lifecycle
- 2: RPC calls & responses
- 3: model streaming & internals

Set `EDINBURGH_LOG_LEVEL` similarly for Edinburgh internals.

## Server API Reference

The following is auto-generated from `server/server.ts`:

### createStreamType · [function](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L162)

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

### sendModel · [function](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L262)

Sends (updated) data for `model` to `target`.
`target` is a virtual socket with a requestId+'d' user prefix, or a channel that subscribes such virtual sockets.

**Signature:** `(target: number | Uint8Array<ArrayBufferLike> | number[], model: Model<any>, commitId: number, StreamType: typeof StreamTypeBase<any>, changed?: Change) => void`

**Parameters:**

- `target: Uint8Array | number | number[]`
- `model: E.Model<any>`
- `commitId: number`
- `StreamType: typeof StreamTypeBase<any>`
- `changed?: E.Change`

### pushModel · [function](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L318)

Subscribes `target` to this model, and sends initial data.
`target` is a virtual socket with a requestId+'d' user prefix, or a channel that subscribes such virtual sockets.

**Signature:** `(target: number | Uint8Array<ArrayBufferLike> | number[], model: Model<any>, commitId: number, SubStreamType: typeof StreamTypeBase<any>, delta: number) => void`

**Parameters:**

- `target: number | Uint8Array | number[]`
- `model: E.Model<any>`
- `commitId: number`
- `SubStreamType: typeof StreamTypeBase<any>`
- `delta: number`

### start · [function](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L428)

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

### logLevel · [constant](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L10)

**Value:** `number`

### warpsocket · [class](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L13)

**Type:** `typeof import("/var/home/frank/projects/warpsocket/dist/src/index", { with: { "resolution-mode": "import" } })`

### StreamTypeBase · [abstract class](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L34)

[object Object],[object Object],[object Object]

**Type Parameters:**

- `T`

#### StreamTypeBase.fields · [static property](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L36)

**Type:** `{ [key: string]: number | true; }`

#### StreamTypeBase.id · [static property](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L38)

**Type:** `number`

#### streamTypeBase.toString · [method](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L42)

**Signature:** `() => string`

**Parameters:**


### ServerProxy · [class](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L349)

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

#### serverProxy.toString · [method](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L355)

**Signature:** `() => string`

**Parameters:**


### Socket · [class](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L379)

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

#### socket.send · [method](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L388)

Sends data to the client.

**Signature:** `(data: T) => number`

**Parameters:**

- `data: T` - - Data to send (automatically serialized)

**Returns:** `true` if sent, `false` if socket is closed

#### socket.subscribe · [method](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L394)

**Signature:** `(channel: Uint8Array<ArrayBufferLike>, delta?: number) => void`

**Parameters:**

- `channel: Uint8Array`
- `delta: any` (optional)

#### socket.toString · [method](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L401)

**Signature:** `() => string`

**Parameters:**


#### socket.[Symbol.for('nodejs.util.inspect.custom')] · [method](https://github.com/vanviegen/lowlander/blob/main/server/server.ts#L405)

**Signature:** `() => string`

**Parameters:**


## Client API Reference

The following is auto-generated from `client/client.ts`:

### logLevel · [variable](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L8)

Set to 1-3 for increasing verbosity.

**Value:** `number`

### ClientProxyObject · [type](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L157)

Transforms server-side API objects to client-side proxy objects with type-safe RPC methods.

**Type:** `{
    [K in keyof T]: ClientProxyFunction<T[K]>
}`

### Connection · [class](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L190)

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

#### connection.ws · [property](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L192)

**Type:** `WebSocket`

#### connection.activeRequests · [property](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L193)

**Type:** `Map<number, ActiveRequest>`

#### connection.requestCounter · [property](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L194)

**Type:** `number`

#### connection.reconnectAttempts · [property](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L195)

**Type:** `number`

#### connection.onlineProxy · [property](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L198)

**Type:** `ValueRef<boolean>`

#### connection.api · [property](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L205)

Type-safe proxy to the server-side API. Methods return `PromiseProxy` objects
that work reactively in Aberdeen scopes. `ServerProxy` returns include a
`.serverProxy` property for accessing stateful server APIs.

**Type:** `ClientProxyObject<T>`

#### connection.isOnline · [method](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L218)

Returns the current connection status. Reactive in Aberdeen scopes.

**Signature:** `() => boolean`

**Parameters:**


#### connection.connect · [method](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L220)

**Signature:** `() => void`

**Parameters:**


#### connection.reconnect · [method](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L374)

**Signature:** `() => void`

**Parameters:**


#### connection.pruneCommitIds · [method](https://github.com/vanviegen/lowlander/blob/main/client/client.ts#L388)

**Signature:** `(request: ActiveRequest, maxCommitId: number) => void`

**Parameters:**

- `request: ActiveRequest`
- `maxCommitId: number`

