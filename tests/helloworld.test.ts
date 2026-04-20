import { expect, test, beforeAll, afterEach, beforeEach } from "bun:test";
import { passTime, assertBody, reset as resetAberdeen } from "aberdeen/test-helpers";
import * as E from "edinburgh";
import { start } from "lowlander/server";
import { Connection } from "lowlander/client";
import type * as API from "../examples/helloworld/server/api.js";
import A from "aberdeen";
import * as fakeWarpSocket from "./fake-warpsocket.js";

beforeAll(async () => {
    E.init('.edinburgh_test');
    E.setMaxRetryCount(100);
    await start(
        new URL('../examples/helloworld/server/api.ts', import.meta.url).pathname,
        { injectWarpSocket: fakeWarpSocket },
    );
});

beforeEach(async () => {
    await connect().api.resetTestData(true).promise;
});

afterEach(async () => {
    fakeWarpSocket.reset();
    A.unmountAll();
    await resetAberdeen();
});

function connect() {
    return new Connection<typeof API>(fakeWarpSocket.createClientSocket);
}

test('simple RPC: add', async () => {
    const c = connect();
    const sum = c.api.add(2, 3);
    await passTime();
    expect(sum.value).toBe(5);
});

test('authenticate returns ServerProxy', async () => {
    const c = connect();
    const auth = c.api.authenticate('Frank');
    await passTime(1100);
    expect(auth.value).toBe('secret');
});

test('authenticate with unknown user throws', async () => {
    const c = connect();
    const auth = c.api.authenticate('Nobody');
    auth.promise.catch(() => {}); // prevent unhandled rejection
    await passTime(1100);
    expect(auth.error).toBeDefined();
    expect(auth.error.message).toBe('User not found');
});

test('ServerProxy: getBio', async () => {
    const c = connect();
    const auth = c.api.authenticate('Frank');
    const bio = auth.serverProxy.getBio();
    await passTime(1100);
    expect(bio.value).toContain('Frank is 45 years old');
});

test('ServerProxy: toggleFriend', async () => {
    const c = connect();
    const auth = c.api.authenticate('Frank');
    const result = auth.serverProxy.toggleFriend('Alice');
    await passTime(1100);
    expect(typeof result.value).toBe('boolean');
});

test('model streaming: streamModel', async () => {
    const c = connect();
    const model = c.api.streamModel();
    await passTime();
    expect(model.value).toBeDefined();
    expect(model.value!.name).toBe('Test');
    expect(model.value!.owner).toBeDefined();
    expect(model.value!.owner.name).toBe('Frank');
});

test('two clients see same RPC result', async () => {
    const c1 = connect();
    const c2 = connect();
    const sum1 = c1.api.add(10, 20);
    const sum2 = c2.api.add(10, 20);
    await passTime();
    expect(sum1.value).toBe(30);
    expect(sum2.value).toBe(30);
});

test('online status', async () => {
    const c = connect();
    expect(c.isOnline()).toBe(false);
    await passTime();
    expect(c.isOnline()).toBe(true);
});

test('render RPC result in DOM', async () => {
    const c = connect();
    const sum = c.api.add(7, 8);
    A(() => {
        if (sum.value !== undefined) A('span#' + sum.value);
    });
    assertBody('');
    await passTime();
    expect(sum.value).toBe(15);
    await passTime();
    assertBody('span{"15"}');
});

test('two connections render in same DOM', async () => {
    const c1 = connect();
    const c2 = connect();
    const s1 = c1.api.add(1, 2);
    const s2 = c2.api.add(3, 4);
    A('div', () => {
        A(() => {
            if (s1.value !== undefined) A('span.c1#' + s1.value);
        });
        A(() => {
            if (s2.value !== undefined) A('span.c2#' + s2.value);
        });
    });
    await passTime();
    assertBody('div{span.c1{"3"} span.c2{"7"}}');
});

test('4 connections stream, mutate, and converge', async () => {
    const conns = Array.from({length: 4}, () => connect());
    const models = conns.map(c => c.api.streamModel());
    A('div', () => {
        for (const [i, m] of models.entries()) {
            A(() => {
                if (m.value) A(`span.c${i}#` + m.value.owner.age);
            });
        }
    });
    await passTime();
    conns[0].api.setOwnerAge(100);
    await passTime();
    // All 4 connections increment simultaneously, racing through retries
    await Promise.all(conns.map((c, i) => c.api.incrOwnerAge(i + 1).promise));
    // Await UI update
    await passTime();
    // All 4 should converge; total increment = 1+2+3+4 = 10, so age = 110
    assertBody('div{span.c0{"110"} span.c1{"110"} span.c2{"110"} span.c3{"110"}}');
    // Restore original age
    conns[0].api.setOwnerAge(45);
    await passTime();
});

test('stream direct field mutation', async () => {
    const c = connect();
    const model = c.api.streamModel();
    await passTime();
    expect(model.value!.name).toBe('Test');
    await c.api.setModelName('Changed').promise;
    await passTime();
    expect(model.value!.name).toBe('Changed');
    // restore
    await c.api.setModelName('Test').promise;
    await passTime();
});

test('stream record field', async () => {
    const c = connect();
    const model = c.api.streamModel();
    await passTime();
    expect(model.value!.meta).toEqual({score: 42, level: 7});
});

test('stream record field mutation', async () => {
    const c = connect();
    const model = c.api.streamModel();
    await passTime();
    await c.api.setMeta('score', 99).promise;
    await passTime();
    expect(model.value!.meta).toEqual({score: 99, level: 7});
    await c.api.deleteMeta('level').promise;
    await passTime();
    expect(model.value!.meta).toEqual({score: 99});
    // restore
    await c.api.setMeta('score', 42).promise;
    await c.api.setMeta('level', 7).promise;
    await passTime();
});

test('cached stream: linger and reuse', async () => {
    const c = connect();
    const show = A.proxy(true);
    let renders = 0;

    A(() => {
        if (show.value) {
            let model = c.api.streamModelCached();
            A(() => {
                if (model.value) {
                    renders++;
                    A('span#' + model.value.name);
                }
            });
        }
    });
    await passTime();
    assertBody('span{"Test"}');

    // Go out of scope — linger starts
    show.value = false;
    await passTime();
    assertBody('');

    // Reuse within cache window — value immediately available (no undefined→value transition)
    renders = 0;
    show.value = true;
    await passTime();
    assertBody('span{"Test"}');
    expect(renders).toBe(1); // only one render, not two (undefined then value)

    // Mutation still propagates through the lingered stream (same channel reused)
    await c.api.setModelName('Reused').promise;
    await passTime();
    assertBody('span{"Reused"}');

    // Restore
    await c.api.setModelName('Test').promise;
    await passTime();
});

test('cached stream: dedup and refcount', async () => {
    const c = connect();
    const show = A.proxy(true);
    let renders = 0;

    // First scope creates the stream and populates the cache
    let model1: any;
    A(() => {
        model1 = c.api.streamModelCached();
        A(() => {
            if (model1.value) A('span.a#' + model1.value.name);
        });
    });
    await passTime();
    assertBody('span.a{"Test"}');

    // Second scope reuses the cached stream — same resultProxy, renders instantly
    let model2: any;
    A(() => {
        if (show.value) {
            model2 = c.api.streamModelCached();
            A(() => {
                if (model2.value) {
                    renders++;
                    A('span.b#' + model2.value.name);
                }
            });
        }
    });
    assertBody('span.a{"Test"} span.b{"Test"}');
    expect(model1).toBe(model2); // shared proxy
    expect(renders).toBe(1); // immediate, no undefined→value cycle

    // Destroy second scope — first still works (refCount > 0, no linger)
    show.value = false;
    await passTime();
    assertBody('span.a{"Test"}');
});

test('onDrop: scope destroy decrements onlineCount', async () => {
    const c = connect();
    const show = A.proxy(true);
    let auth: any;
    A(() => {
        if (show.value) {
            auth = c.api.authenticate('Frank');
        }
    });
    await auth.promise;
    let online = await c.api.getOnlineUsers().promise;
    expect(online).toEqual(['Frank']);

    // Destroy scope → cancel → onDrop
    show.value = false;
    await passTime(100);
    online = await c.api.getOnlineUsers().promise;
    expect(online).toEqual([]);
});

test('onDrop: websocket close decrements onlineCount', async () => {
    const c = connect();
    await c.api.authenticate('Frank').promise;

    const c2 = connect();
    let online = await c2.api.getOnlineUsers().promise;
    expect(online).toEqual(['Frank']);

    // Close the first connection's underlying socket.
    // Bun.sleep gives the real event loop time to complete the onDrop E.transact()
    // commit — we can't await it because there's no handle on the close-triggered cleanup.
    (c as any).ws.close();
    await passTime(100);
    await Bun.sleep(10);
    online = await c2.api.getOnlineUsers().promise;
    expect(online).toEqual([]);
});

test('RPC with default parameter', async () => {
    const c = connect();
    const r1 = c.api.greet('Alice');
    const r2 = c.api.greet('Alice', 'Hi');
    await passTime();
    expect(r1.value).toBe('Hello, Alice!');
    expect(r2.value).toBe('Hi, Alice!');
});
