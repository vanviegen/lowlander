import { expect, test, beforeAll, afterEach, beforeEach } from "vitest";
import { passTime, reset as resetAberdeen } from "aberdeen/test-helpers";
import * as E from "edinburgh";
import { start } from "lowlander/server";
import { Connection } from 'lowlander/client';
import type * as API from "../examples/helloworld/server/api.js";
import A from "aberdeen";
import * as fakeWarpSocket from "./fake-warpsocket.js";

process.env.LOWLANDER_DASHBOARD_PASSWORD = 'test-secret-pw';

beforeAll(async () => {
    E.init('.edinburgh_test_dashboard');
    E.setMaxRetryCount(100);
    await start(
        new URL('../examples/helloworld/server/api.ts', import.meta.url).pathname,
        { injectWarpSocket: fakeWarpSocket as any },
    );
});

beforeEach(async () => {
    await connect().api.resetTestData(true).promise;
});

afterEach(async () => {
    A.unmountAll();
    await fakeWarpSocket.reset();
    await resetAberdeen();
});

function connect() {
    return new Connection<typeof API>(fakeWarpSocket.createClientSocket);
}

test('dashboard: wrong password rejected', async () => {
    const c = connect();
    const auth = c.api._dashboard('nope');
    auth.promise.catch(() => {});
    await passTime();
    expect(auth.error).toBeDefined();
    expect(auth.error.message).toMatch(/dashboard password/i);
});

test('dashboard: correct password returns ServerProxy and lists models', async () => {
    const c = connect();
    const auth = c.api._dashboard('test-secret-pw');
    const models = auth.serverProxy.listModels();
    await passTime();
    expect(auth.value).toBe('authenticated');
    expect(Array.isArray(models.value)).toBe(true);
    expect(models.value!.some(m => m.tableName === 'Person')).toBe(true);
});

test('dashboard: getModel returns fields and indexes', async () => {
    const c = connect();
    const auth = c.api._dashboard('test-secret-pw');
    const info = auth.serverProxy.getModel('Person');
    await passTime();
    expect(info.value!.tableName).toBe('Person');
    expect(info.value!.fields.some(f => f.name === 'name')).toBe(true);
    expect(info.value!.indexes.some(i => i.name === '(primary)')).toBe(true);
});

test('dashboard: listApiMethods includes add', async () => {
    const c = connect();
    const auth = c.api._dashboard('test-secret-pw');
    const methods = auth.serverProxy.listApiMethods();
    await passTime();
    expect(methods.value!.some(m => m.name === 'add')).toBe(true);
});
