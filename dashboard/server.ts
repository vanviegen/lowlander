import * as E from 'edinburgh';
import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ServerProxy, createStreamType, getStreamTypesForModel, warpsocket } from '../server/server.js';
import { getMainApi } from '../server/wshandler.js';

// `modelRegistry` is a documented export of edinburgh's models module but is
// not re-exported from the package entry. Reach it by URL relative to the
// resolved package main — works in both Bun (.ts) and Node (built .js).
const _modelsModule = await import(new URL('./models.js', import.meta.resolve('edinburgh')).href) as {
    modelRegistry: Record<string, E.AnyModelClass>;
};
const modelRegistry = _modelsModule.modelRegistry;

const PW_FILE = join(process.cwd(), '.lowlander_dashboard_password');

function ensurePassword(): string {
    let password = process.env.LOWLANDER_DASHBOARD_PASSWORD;
    if (password) {}
    else if (existsSync(PW_FILE)) {
        password = readFileSync(PW_FILE, 'utf8').trim();
    } else {
        const candidate = randomBytes(24).toString('base64url');
        try {
            writeFileSync(PW_FILE, candidate, { flag: 'wx' });
        } catch {
            // Another worker won the race
        }
        password = readFileSync(PW_FILE, 'utf8').trim();
    }
    console.log('\n========================================================');
    console.log('  Lowlander dashboard password:  ' + password);
    console.log('========================================================\n');
    return password;
}

let cachedPassword: string | undefined;
export function getPassword(): string {
    if (process.env.LOWLANDER_DASHBOARD_PASSWORD) return process.env.LOWLANDER_DASHBOARD_PASSWORD;
    return (cachedPassword ??= ensurePassword());
}

function passwordOk(provided: string): boolean {
    const expected = getPassword();
    if (typeof provided !== 'string' || provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function describeType(type: E.TypeWrapper<unknown>): { kind: string; display: string; linkedModel?: string } {
    const linked = type.getLinkedModel();
    return {
        kind: (type as any).kind,
        display: type.toString(),
        linkedModel: linked?.tableName,
    };
}

function describeIndex(index: any) {
    const fields = Array.from(index._indexFields.keys()) as string[];
    return {
        fields,
        fieldTypes: fields.map(f => describeType(index._indexFields.get(f))),
        computed: !!index._computeFn,
        kind: index._getTypeName() as 'primary' | 'unique' | 'secondary',
    };
}

function describeModel(Model: E.AnyModelClass) {
    const fields: { name: string; type: ReturnType<typeof describeType>; description?: string; hasDefault: boolean }[] = [];
    for (const [name, cfg] of Object.entries(Model.fields) as [string, E.FieldConfig<unknown>][]) {
        fields.push({
            name,
            type: describeType(cfg.type),
            description: cfg.description,
            hasDefault: cfg.default !== undefined,
        });
    }
    const indexes: { name: string; info: ReturnType<typeof describeIndex> }[] = [{
        name: '(primary)',
        info: describeIndex(Model),
    }];
    for (const [name, idx] of Object.entries((Model as any)._secondaries || {})) {
        indexes.push({ name, info: describeIndex(idx) });
    }
    const streamTypes = getStreamTypesForModel(Model).map((ST: any) => ({
        id: ST.id,
        fields: ST.fields,
        cache: ST.cache,
    }));
    return {
        tableName: Model.tableName,
        fields,
        indexes,
        streamTypes,
    };
}

function serializeValue(v: any, depth = 0): any {
    if (v === null || v === undefined) return v;
    if (v instanceof E.Model) {
        const cls: any = v.constructor;
        const tn = cls.tableName || cls.name;
        const pkBytes = (v as any).getPrimaryKey?.();
        const pkArr = pkBytes && cls._pkToArray ? cls._pkToArray(pkBytes) : null;
        const pk = pkArr ? (pkArr.length === 1 ? pkArr[0] : pkArr) : null;
        return { __ref: tn, pk };
    }
    if (v instanceof Uint8Array) return Array.from(v.slice(0, 64)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Set) return depth > 2 ? `Set(${v.size})` : Array.from(v).map(x => serializeValue(x, depth + 1));
    if (Array.isArray(v)) return depth > 2 ? `Array(${v.length})` : v.map(x => serializeValue(x, depth + 1));
    if (typeof v === 'object') {
        if (depth > 2) return '...';
        const out: Record<string, any> = {};
        for (const k of Object.keys(v)) out[k] = serializeValue(v[k], depth + 1);
        return out;
    }
    return v;
}

function instanceToPlain(instance: any): Record<string, any> {
    const Model = instance.constructor as E.AnyModelClass;
    const out: Record<string, any> = {};
    for (const fieldName of Object.keys(Model.fields)) {
        try {
            out[fieldName] = serializeValue((instance as any)[fieldName]);
        } catch (err: any) {
            out[fieldName] = `<error: ${err?.message || err}>`;
        }
    }
    return out;
}

function modelByName(name: string): E.AnyModelClass {
    const Model = modelRegistry[name];
    if (!Model) throw new Error(`Unknown model: ${name}`);
    return Model;
}

function findIndex(Model: E.AnyModelClass, indexName: string): any {
    if (indexName === '(primary)') return Model;
    const idx = (Model as any)._secondaries?.[indexName];
    if (!idx) throw new Error(`Unknown index ${indexName} on ${Model.tableName}`);
    return idx;
}

// =====================================================================

class DashboardAPI {
    listModels() {
        return Object.keys(modelRegistry).sort().map(name => ({
            tableName: name,
            indexCount: 1 + Object.keys((modelRegistry[name] as any)._secondaries || {}).length,
            fieldCount: Object.keys(modelRegistry[name].fields).length,
            streamTypeCount: getStreamTypesForModel(modelRegistry[name]).length,
        }));
    }

    getModel(name: string) {
        return describeModel(modelByName(name));
    }

    listApiMethods() {
        const api = getMainApi();
        if (!api) return [];
        const out: { name: string; kind: 'function' | 'value' }[] = [];
        for (const key of Object.keys(api).sort()) {
            if (key === '_dashboard' || key.startsWith('_')) continue;
            const v = (api as any)[key];
            out.push({ name: key, kind: typeof v === 'function' ? 'function' : 'value' });
        }
        return out;
    }

    getApiMethodSource(name: string): string | undefined {
        const api = getMainApi();
        const fn = api && (api as any)[name];
        if (typeof fn !== 'function') return undefined;
        try {
            // Bundlers usually preserve enough source for a useful preview
            const s = String(fn);
            return s.length > 4000 ? s.slice(0, 4000) + '\n/* … truncated */' : s;
        } catch {
            return undefined;
        }
    }

    findRecords(modelName: string, indexName: string, opts: {
        search?: any;
        reverse?: boolean;
        limit?: number;
    } = {}) {
        const Model = modelByName(modelName);
        const idx = findIndex(Model, indexName);
        const fieldNames = Array.from(idx._indexFields.keys()) as string[];

        const findOpts: any = {};
        if (opts.search !== undefined && opts.search !== '') {
            findOpts.is = opts.search;
        }
        if (opts.reverse) findOpts.reverse = true;

        const limit = Math.min(opts.limit ?? 10, 1000);
        let iter: Iterable<any>;
        try { iter = idx.find(findOpts); }
        catch { return { rows: [], indexFields: fieldNames, scanned: 0 }; }
        const results: { pk: any; values: Record<string, any> }[] = [];
        let scanned = 0;
        for (const row of iter) {
            scanned++;
            const plain = instanceToPlain(row);
            const cls: any = (row as any).constructor;
            const pkBytes = (row as any).getPrimaryKey ? (row as any).getPrimaryKey() : null;
            const pkArr = pkBytes && cls._pkToArray ? cls._pkToArray(pkBytes) : null;
            const pk = pkArr ? (pkArr.length === 1 ? pkArr[0] : pkArr) : null;
            results.push({
                pk: serializeValue(pk),
                values: plain,
            });
            if (results.length >= limit) break;
        }
        return {
            rows: results,
            indexFields: fieldNames,
            scanned,
        };
    }

    getRecord(modelName: string, pk: any) {
        const Model = modelByName(modelName);
        const pkArgs = Array.isArray(pk) ? pk : [pk];
        const instance = (Model as any).get(...pkArgs);
        if (!instance) return undefined;
        return instanceToPlain(instance);
    }

    streamRecord(modelName: string, streamTypeId: number, pk: any) {
        const Model = modelByName(modelName);
        const ST = getStreamTypesForModel(Model).find((s: any) => s.id === streamTypeId) as any;
        if (!ST) throw new Error(`No stream type with id ${streamTypeId} for ${modelName}`);
        const pkArgs = Array.isArray(pk) ? pk : [pk];
        const instance = (Model as any).get(...pkArgs);
        if (!instance) throw new Error('Record not found');
        return new ST(instance);
    }

    getDebugState(mode: 'channels' | 'sockets' | 'workers' | 'kv') {
        return warpsocket.getDebugState(mode as any);
    }
}

const DashboardProxyValue = 'authenticated';

/**
 * RPC entry point. Re-export this from your top-level api file:
 *
 * ```ts
 * export { _dashboard } from 'lowlander/dashboard';
 * ```
 *
 * On first call, a password is generated (or reused from the
 * `LOWLANDER_DASHBOARD_PASSWORD` env var) and printed to the server console.
 */
export function _dashboard(password: string) {
    if (!passwordOk(password)) {
        throw new Error('Invalid dashboard password');
    }
    return new ServerProxy(new DashboardAPI(), DashboardProxyValue);
}

// Eagerly init the password on first import so it shows up at startup
getPassword();

// Re-export so callers don't need a separate import
export type { DashboardAPI };

// Convenience stream type used internally so live record viewing works
// for arbitrary models without the developer having to pre-create one.
// (Built lazily per model+selection because createStreamType is keyed on the
// shape of the selection.)
const allFieldsStreams = new Map<string, ReturnType<typeof createStreamType>>();
export function _dashboardAllFieldsStream(modelName: string) {
    // Currently unused; kept for future "view live" feature.
    void allFieldsStreams;
    void modelName;
}
