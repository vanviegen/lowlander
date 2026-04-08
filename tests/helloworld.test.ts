import { expect, test, beforeAll, afterEach } from "bun:test";
import { passTime, assertBody, reset as resetAberdeen } from "aberdeen/test-helpers";
import * as E from "edinburgh";
import { start } from "lowlander/server";
import { Connection } from "lowlander/client";
import type * as API from "../examples/helloworld/server/api.js";
import A from "aberdeen";
import * as fakeWarpSocket from "./fake-warpsocket.js";

beforeAll(async () => {
    E.init('.edinburgh_test');
    await start(
        new URL('../examples/helloworld/server/api.ts', import.meta.url).pathname,
        { injectWarpSocket: fakeWarpSocket },
    );
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
    expect(bio.value).toContain('Frank');
    expect(bio.value).toContain('45');
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
