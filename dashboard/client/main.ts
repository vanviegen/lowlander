import A from 'aberdeen';
import { current as route, go } from 'aberdeen/route';
import S from 'staffa';
import { Connection, type ClientProxyObject } from 'lowlander/client';
import type { _dashboard } from './shim-server.js';
import { openCreateModal, openEditModal, openDeleteConfirm } from './crud.js';

type ServerExports = { _dashboard: typeof _dashboard };
type API = ClientProxyObject<ServerExports>;

interface Settings {
    wsUrl: string;
    password: string;
}

const SETTINGS_KEY = 'lowlander-dashboard';
function loadSettings(): Partial<Settings> {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s: Partial<Settings>) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const defaultWs = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/`;
};

const stored = loadSettings();
const $state = A.proxy({
    wsUrl: stored.wsUrl || defaultWs(),
    password: stored.password || '',
    loginError: '' as string,
    connected: false,
    authed: false,
    indexRefreshKey: 0,
    connecting: false,
    connection: undefined as Connection<ServerExports> | undefined,
});
let api: API | undefined;
let authProxy: ReturnType<API['_dashboard']> | undefined;

// URL-backed state helpers (reactive via A.route.current.search)
const url = {
    get debug() { return route.search.debug === '1'; },
    set debug(v: boolean) { setSearch('debug', v ? '1' : ''); },
    get model() { return route.search.model || ''; },
    set model(v: string) { setSearch('model', v); },
    get index() { return route.search.index || ''; },
    set index(v: string) { setSearch('index', v); },
    get search() { return route.search.search || ''; },
    set search(v: string) { setSearch('search', v); },
    get reverse() { return route.search.reverse === '1'; },
    set reverse(v: boolean) { setSearch('reverse', v ? '1' : ''); },
    get limit() { return parseInt(route.search.limit || '10', 10) || 10; },
    set limit(v: number) { setSearch('limit', v === 10 ? '' : String(v)); },
    get pk() { return route.search.pk || ''; },
    set pk(v: string) { setSearch('pk', v); },
};

function setSearch(k: string, v: string) {
    const s = route.search;
    if (v === '' || v === undefined) delete s[k];
    else s[k] = v;
}

function effectiveIndex() { return url.index || '(primary)'; }
function effectivePk(): string { return url.pk === '-' ? '' : url.pk; }

const tableClass = A.insertCss({
    '&': 'w:100% border-collapse:collapse font-size:12.5px',
    '& th,& td': 'text-align:left p: 4px 8px; border-bottom: 1px solid $sBorder; vertical-align:top',
    '& th': 'bg:$sSurfaceHi fg:$sFgMuted font-weight:600',
    '& tbody tr': 'cursor:default',
    '& tbody tr:hover': 'background:#ffffff08',
    '& tbody tr.selectable': 'cursor:pointer',
    '& tbody tr.selected': 'background: color-mix(in srgb, var(--sPrimary) 12%, transparent);',
    '& tbody tr.selected td:first-child': 'border-left: 3px solid $sPrimary; padding-left: 5px;',
});

A.insertGlobalCss({
    '.sidebarSel': 'background: color-mix(in srgb, var(--sPrimary) 12%, transparent); box-shadow: inset 3px 0 0 var(--sPrimary)',
    '.tag': 'display:inline-block bg:$sSurfaceHi fg:$sFgMuted p: 1px 6px; r:3px font-size:11px ml:$1',
});

function login() {
    S.main({
        title: 'Lowlander Dashboard',
        maxWidth: '24rem',
        content: () => {
            A(() => {
                if ($state.connecting && !$state.connection?.getError()) {
                    A('p', 'text-align:center fg:$sFgMuted', '#Connecting…');
                    return;
                }
                S.form({
                    submit: () => attemptLogin(),
                    content: () => {
                        S.textline({ label: 'WebSocket URL', bind: A.ref($state, 'wsUrl') });
                        S.textline({ label: 'Password', type: 'password', bind: A.ref($state, 'password'), control: 'autofocus=' });
                        A(() => {
                            const err = $state.connection?.getError() || $state.loginError;
                            if (err) A('p', 'fg:$sDanger m:0', 'text=', err);
                        });
                    },
                    actions: () => S.button({
                        text: $state.connected && !$state.authed ? 'Checking…' : 'Log in',
                        type: 'submit',
                        disabled: $state.connected && !$state.authed,
                    }),
                });
            });
        },
    });
}

async function attemptLogin() {
    $state.connecting = true;
    $state.loginError = '';
    saveSettings({ wsUrl: $state.wsUrl, password: $state.password });
    try {
        if ($state.connection) ($state.connection as any).ws?.close?.();
    } catch {}
    $state.connection = new Connection<ServerExports>($state.wsUrl);
    api = $state.connection.api;
    $state.connected = false;
    $state.authed = false;
    const proxy = api._dashboard($state.password);
    authProxy = proxy;
    try {
        await (proxy as any).promise;
        $state.connected = true;
        $state.authed = true;
        $state.connecting = false;
    } catch (err: any) {
        $state.connecting = false;
        $state.loginError = err?.message || 'Login failed';
        $state.connected = false;
        $state.authed = false;
        $state.connection = undefined;
        api = undefined;
        authProxy = undefined;
    }
}

function logout() {
    $state.authed = false;
    $state.connected = false;
    $state.password = '';
    saveSettings({ wsUrl: $state.wsUrl, password: '' });
    try { ($state.connection as any)?.ws?.close?.(); } catch {}
    $state.connection = undefined;
    api = undefined;
    authProxy = undefined;
}

function sidebar() {
    A('aside', 'w:280px bg:$sSurface border-right: 1px solid $sBorder; display:flex flex-direction:column overflow:hidden', () => {
        A('div', 'p:$3 border-bottom: 1px solid $sBorder; display:flex justify-content:space-between align-items:center', () => {
            A('strong#Lowlander');
            S.button({ text: 'Logout', variant: 'outlined', color: 'destroy', size: 'sm', click: logout });
        });
        A('div', 'overflow:auto flex:1 p:$2', () => {
            if (!authProxy) return;
            sidebarModels();
            A('div', 'border-top: 1px solid $sBorder; mt:$2 pt:$2', () => {
                A('div', 'p: 6px 8px; r:$sRadius cursor:pointer',
                    'click=', () => { go({ path: route.path, search: { debug: '1' } }); },
                    () => {
                        A(() => A('.sidebarSel=', url.debug));
                        A('span#⬡ WarpSocket debug');
                    });
            });
        });
    });
}

function sidebarModels() {
    const models = authProxy!.serverProxy.listModels();
    A(() => {
        if (models.busy) { A('div', 'fg:$sFgMuted', '#Loading…'); return; }
        if (models.error) { A('div', 'fg:$sDanger', 'text=', models.error.message); return; }
        const list = models.value || [];
        for (const m of list) {
            A('div', 'p: 6px 8px; r:$sRadius cursor:pointer',
                'click=', () => { go({ path: route.path, search: { model: m.tableName } }); },
                () => {
                    A(() => A('.sidebarSel=', !url.debug && url.model === m.tableName));
                    A('div', 'display:flex justify-content:space-between align-items:baseline', () => {
                        A('span', 'text=', m.tableName);
                        A('span.tag', 'text=', `${m.fieldCount}f ${m.indexCount}i ${m.streamTypeCount}s`);
                    });
                });
        }
    });
}

function mainArea() {
    A('main', 'flex:1 overflow:auto p:$4', () => {
        if (!authProxy) return;
        if (url.debug) debugView();
        else if (url.model) modelDetail();
        else A('div', 'fg:$sFgMuted p:$4 text-align:center', '#Select a model from the sidebar');
    });
}

function modelDetail() {
    const name = url.model;
    const info = authProxy!.serverProxy.getModel(name);
    A(() => {
        if (info.busy) { A('div', 'fg:$sFgMuted', '#Loading…'); return; }
        if (info.error) { A('div', 'fg:$sDanger', 'text=', info.error.message); return; }
        const m = info.value;
        if (!m) return;

        A('h2', 'm:0 mb:$2', 'text=', m.tableName);

        A('section', 'mb:$4', () => {
            A('h3#Fields', 'm:0 mb:$2 fg:$sFgMuted font-weight:600');
            A('table', tableClass, () => {
                A('thead tr', () => { A('th#Name'); A('th#Type'); A('th#Linked'); A('th#Default'); A('th#Description'); });
                A('tbody', () => {
                    for (const f of m.fields) {
                        A('tr', () => {
                            A('td', () => A('code', 'text=', f.name));
                            A('td', 'fg:$sSuccess', 'text=', f.type.display);
                            A('td', () => { const lm = f.type.linkedModel; if (lm) modelLink(lm); });
                            A('td', 'text=', f.hasDefault ? '✓' : '');
                            A('td', 'fg:$sFgMuted', 'text=', f.description || '');
                        });
                    }
                });
            });
        });

        A('section', 'mb:$4', () => {
            A('h3#Indexes', 'm:0 mb:$2 fg:$sFgMuted font-weight:600');
            indexesTable(m);
        });

        A(() => {
            const cur = effectiveIndex();
            const idx = m.indexes.find((i: any) => i.name === cur);
            if (!idx) return;
            A('section', 'mb:$4', () => {
                A('div', 'display:flex justify-content:space-between align-items:center mb:$2', () => {
                    A('h3', 'm:0 fg:$sFgMuted font-weight:600', 'text=', `Data for ${cur}`);
                    S.button({ text: '+ New', variant: 'outlined', size: 'sm', click: () => {
                        openCreateModal(authProxy!, m.tableName, m.fields, () => { $state.indexRefreshKey++; });
                    }});
                });
                indexBrowser(m, idx);
            });
        });

        if (m.streamTypes.length) A('section', 'mb:$4', () => {
            A('h3#Stream types', 'm:0 mb:$2 fg:$sFgMuted font-weight:600');
            streamTypesTable(m);
        });
    });
}

function modelLink(modelName: string, pk?: any, display?: string) {
    A('a', 'click=', (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        const search: Record<string, string | number> = { model: modelName };
        if (pk !== undefined) { search.search = jsonStringify(pk); search.limit = 1; }
        go({ path: route.path, search });
    }, 'text=', display ?? modelName);
}

function jsonStringify(v: any): string {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

function indexesTable(m: any) {
    A('table', tableClass, () => {
        A('thead tr', () => { A('th#Name'); A('th#Kind'); A('th#Fields'); });
        A('tbody', () => {
            for (const idx of m.indexes) {
                A('tr.selectable', 'click=', () => {
                    if (effectiveIndex() === idx.name) return;
                    url.index = (idx.name === '(primary)') ? '' : idx.name;
                    url.pk = '';
                    url.search = '';
                }, () => {
                    A(() => A('.selected=', effectiveIndex() === idx.name));
                    A('td', () => A('code', 'text=', idx.name));
                    A('td', 'fg:$sSuccess', 'text=', idx.info.kind);
                    A('td', 'text=', idx.info.fields.join(', ') || '(computed)');
                });
            }
        });
    });
}

function streamTypesTable(m: any) {
    const fieldByName: Record<string, any> = {};
    for (const f of m.fields) fieldByName[f.name] = f;

    const seen = new Set<number>();
    const streamTypes = (m.streamTypes as any[]).filter(st => {
        if (seen.has(st.id)) return false;
        seen.add(st.id);
        return true;
    });

    A('table', tableClass, () => {
        A('thead tr', () => { A('th#id'); A('th#cache'); A('th#fields'); A('th', 'w:100%', '#live view for selected row'); });
        A('tbody', () => {
            for (const st of streamTypes) {
                A('tr', () => {
                    A('td', () => A('code', 'text=', String(st.id)));
                    A('td', 'text=', st.cache ? `${st.cache}s` : '');
                    A('td', () => streamFieldsInline(st.fields, fieldByName));
                    A('td', () => streamLiveCell(m.tableName, st.id));
                });
            }
        });
    });
}

function streamFieldsInline(sel: any, fieldByName: Record<string, any>) {
    if (sel === true) { A('span', 'fg:$sFgMuted', '#(scalar)'); return; }
    if (!sel || typeof sel !== 'object') { A('span', 'text=', String(sel)); return; }
    for (const [k, v] of Object.entries(sel)) {
        if (typeof v === 'number') {
            const linked = fieldByName[k]?.type?.linkedModel;
            A(`div#${k}→`, () => {
                if (linked) modelLink(linked, undefined, v.toString());
                else A('#?');
            });
        } else if (v === false) {
            A(`div#${k}*`);
        } else {
            A(`div#${k}`);
        }
    }
}

function streamLiveCell(modelName: string, streamTypeId: number) {
    A(() => {
        const pkRaw = effectivePk();
        if (!pkRaw) { A('span', 'fg:$sFgMuted', '#(select a row)'); return; }
        let pk: any;
        try { pk = JSON.parse(pkRaw); } catch { pk = pkRaw; }
        const $stream = authProxy!.serverProxy.streamRecord(modelName, streamTypeId, pk);
        A(() => {
            if ($stream.busy) { A('span', 'fg:$sFgMuted', '#…'); return; }
            if ($stream.error) { A('span', 'fg:$sDanger', 'text=', $stream.error.message); return; }
            A.dump($stream.value);
        });
    });
}

function indexBrowser(m: any, idx: any) {
    const modelName = m.tableName;
    const indexName = idx.name;

    const searchBind = {
        get value() { return url.search; },
        set value(v: string | number) { url.search = String(v); url.limit = 10; },
    };
    const reverseBind = {
        get value() { return url.reverse; },
        set value(v: any) { url.reverse = Boolean(v); },
    };

    A('div', 'display:flex flex-direction:column', () => {
        A('div', 'display:flex flex-wrap:wrap gap:$2 align-items:center mb:$2', () => {
            S.textline({ placeholder: 'search', root: 'flex:1 min-w:200px', bind: searchBind });
            S.checkbox({ label: 'reverse', bind: reverseBind });
            S.button({ text: '↺', variant: 'outlined', size: 'sm', ariaLabel: 'Refresh',
                click: () => $state.indexRefreshKey++ });
        });

        A(() => {
            void $state.indexRefreshKey;
            const opts = {
                search: parseMaybe(url.search),
                reverse: url.reverse,
                limit: url.limit,
            };
            const rows = authProxy!.serverProxy.findRecords(modelName, indexName, opts);
            A(() => {
                if (rows.busy) { A('div', 'fg:$sFgMuted', '#Loading…'); return; }
                if (rows.error) { A('div', 'fg:$sDanger', 'text=', rows.error.message); return; }
                const r = rows.value;
                if (!r) return;
                if (!url.pk && r.rows.length > 0) {
                    url.pk = jsonStringify(r.rows[0].pk);
                    return;
                }
                A('div', 'fg:$sFgMuted mb:$2 font-size:12px', 'text=', `${r.rows.length} rows (scanned ${r.scanned})`);
                if (!r.rows.length) { A('div', 'fg:$sFgMuted', '#(empty)'); return; }
                A('div', 'overflow:auto', () => {
                    A('table', tableClass, () => {
                        const cols = Object.keys(r.rows[0].values);
                        A('thead tr', () => {
                            for (const c of cols) A('th', 'text=', c);
                            A('th', 'w:1px');
                        });
                        A('tbody', () => {
                            for (const row of r.rows) {
                                const pkStr = jsonStringify(row.pk);
                                A('tr.selectable', 'click=', () => { url.pk = (effectivePk() === pkStr) ? '-' : pkStr; }, () => {
                                    A(() => A('.selected=', effectivePk() === pkStr));
                                    for (const c of cols) {
                                        A('td', () => A.dump(wrapForDump((row.values as any)[c])));
                                    }
                                    A('td', 'text-align:right white-space:nowrap p: 2px 4px;', () => {
                                        S.button({ text: '✎', variant: 'outlined', size: 'sm', root: 'mr:$1',
                                            ariaLabel: 'Edit', click: (e) => {
                                                e.stopPropagation();
                                                openEditModal(authProxy!, modelName, m.fields, row.pk, row.values, () => {
                                                    $state.indexRefreshKey++;
                                                });
                                            },
                                        });
                                        S.button({ text: '✕', variant: 'outlined', color: 'danger', size: 'sm',
                                            ariaLabel: 'Delete', click: (e) => {
                                                e.stopPropagation();
                                                openDeleteConfirm(authProxy!, modelName, row.pk, pkStr, () => {
                                                    $state.indexRefreshKey++;
                                                    if (effectivePk() === pkStr) url.pk = '-';
                                                });
                                            },
                                        });
                                    });
                                });
                            }
                        });
                    });
                });
                if (r.rows.length >= url.limit) {
                    A('div', 'mt:$2', () => {
                        A(() => S.button({
                            text: `+ more (currently limit ${url.limit})`,
                            variant: 'outlined', size: 'sm',
                            click: () => { const cur = url.limit; url.limit = Math.min(cur * 5, cur + 250); },
                        }));
                    });
                }
            });
        });
    });
}

function wrapForDump(v: any): any {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof Date) return v;
    if (v.__ref) {
        const ref = v.__ref, pk = v.pk;
        return { [A.CUSTOM_DUMP]() { modelLink(ref, pk, `<${ref} ${jsonStringify(pk)}>`); } };
    }
    if (Array.isArray(v)) return v.map(wrapForDump);
    const result: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) result[k] = wrapForDump(val);
    return result;
}

function parseMaybe(s: string): any {
    if (s === '') return undefined;
    if (s === 'true') return true; if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    try { return JSON.parse(s); } catch {}
    return s;
}

function debugView() {
    A('h2#WarpSocket debug', 'm:0 mb:$3');
    const $mode = A.proxy({ value: 'channels' as string });
    S.tabs({
        bind: $mode,
        tabs: (['channels', 'sockets', 'workers', 'kv'] as const).map(t => ({
            id: t,
            label: t,
            content: () => {
                const debugInfo = authProxy!.serverProxy.getDebugState(t);
                A(() => {
                    if (debugInfo.busy) { A('div', 'fg:$sFgMuted', '#Loading…'); return; }
                    if (debugInfo.error) { A('div', 'fg:$sDanger', 'text=', debugInfo.error.message); return; }
                    const data = A.unproxy(debugInfo.value) as undefined | Record<string, Record<string, any>>;
                    if (!data) return;
                    const keySet = new Set<string>();
                    for (const obj of Object.values(data)) {
                        if (obj && typeof obj === 'object' && !(obj instanceof Uint8Array))
                            for (const k of Object.keys(obj)) keySet.add(k);
                    }
                    const cols = [...keySet];
                    A('div', 'overflow:auto', () => {
                        A('table', tableClass, () => {
                            A('thead tr', () => {
                                A('th##');
                                for (const k of cols) A('th', 'text=', k);
                            });
                            A('tbody', () => {
                                for (const [idx, obj] of Object.entries(data)) {
                                    A('tr', () => {
                                        A('td', () => A('code', 'text=', idx));
                                        for (const k of cols) A('td', 'font-size:12px font-family:monospace', 'text=', debugCellText(obj?.[k]));
                                    });
                                }
                            });
                        });
                    });
                });
            },
        })),
    });
}

function debugCellText(value: any): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Uint8Array) return escapeBytes([...value]);
    if (typeof value === 'object') {
        if (value.type === 'Buffer' && Array.isArray(value.data)) return escapeBytes(value.data);
        const keys = Object.keys(value);
        if (!Array.isArray(value) && keys.length > 0 && keys.length <= 4096 && keys.every((k, i) => k === String(i))) {
            const arr: number[] = [];
            for (const k of keys) {
                const b = value[k];
                if (typeof b !== 'number' || b < 0 || b > 255) return JSON.stringify(value);
                arr.push(b);
            }
            return escapeBytes(arr);
        }
        return JSON.stringify(value);
    }
    return String(value);
}

function escapeBytes(bytes: number[]): string {
    let s = '';
    for (const b of bytes) {
        if (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c) s += String.fromCharCode(b);
        else if (b === 0x09) s += '\\t';
        else if (b === 0x0a) s += '\\n';
        else if (b === 0x0d) s += '\\r';
        else if (b === 0x22) s += '\\"';
        else if (b === 0x5c) s += '\\\\';
        else s += '\\x' + b.toString(16).padStart(2, '0');
    }
    return s;
}

A.mount(document.body, () => {
    if (!$state.authed) { login(); return; }
    A('div', 'display:flex h:100vh w:100vw overflow:hidden', () => {
        sidebar();
        mainArea();
    });
});

if ($state.password) {
    attemptLogin();
}
