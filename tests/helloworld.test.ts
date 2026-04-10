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
