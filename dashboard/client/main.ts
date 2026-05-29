import A from 'aberdeen';
import { Connection, type ClientProxyObject } from 'lowlander/client';
import type { _dashboard } from './shim-server.js';

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
    section: 'models' as 'models' | 'api' | 'debug' | 'streams',
    selectedModel: '' as string,
    selectedIndex: '' as string,
    selectedMethod: '' as string,
    indexFrom: '' as string,
    indexTo: '' as string,
    indexReverse: false,
    indexSearch: '' as string,
});

let connection: Connection<ServerExports> | undefined;
let api: API | undefined;
let authProxy: ReturnType<API['_dashboard']> | undefined;

function styles() {
    A.cssVars.bg = '#0f1117';
    A.cssVars.panel = '#181b24';
    A.cssVars.panel2 = '#1f2330';
    A.cssVars.fg = '#e5e7eb';
    A.cssVars.muted = '#94a3b8';
    A.cssVars.accent = '#60a5fa';
    A.cssVars.accent2 = '#34d399';
    A.cssVars.danger = '#f87171';
    A.cssVars.border = '#2a2f3d';

    A.insertGlobalCss({
        'html,body': 'm:0 p:0 bg:$bg fg:$fg font-family: -apple-system, system-ui, sans-serif; font-size:14px; h:100vh',
        'body': 'display:flex flex-direction:column',
        'a': 'color:$accent text-decoration:none',
        'a:hover': 'text-decoration:underline',
        'input,select,textarea,button': 'font-family:inherit font-size:inherit',
        'input[type=text],input[type=password],input:not([type]),select,textarea':
            'bg:$panel2 fg:$fg border: 1px solid $border; r:4px p: 6px 8px; outline:none',
        'input:focus,textarea:focus,select:focus': 'border-color:$accent',
        'button': 'bg:$accent fg:#0b1220 border:0 r:4px p: 6px 12px; cursor:pointer font-weight:600',
        'button:hover': 'opacity:0.9',
        'button.ghost': 'bg:transparent fg:$accent border: 1px solid $border;',
        'code,pre': 'font-family: ui-monospace, Menlo, Consolas, monospace; font-size:12.5px',
        'pre': 'bg:#0b0d14 p:$3 r:6px overflow:auto m:0',
        'table': 'border-collapse:collapse w:100% font-size:12.5px',
        'th,td': 'text-align:left p: 4px 8px; border-bottom: 1px solid $border; vertical-align:top',
        'th': 'bg:$panel2 position:sticky top:0',
        'tr:hover': 'bg:#ffffff08',
        '.tag': 'display:inline-block bg:$panel2 fg:$muted p: 1px 6px; r:3px font-size:11px ml:$1',
        '.kind-primary': 'bg:#1e3a8a55 fg:$accent',
        '.kind-unique': 'bg:#0e7a5a55 fg:$accent2',
        '.kind-secondary': 'bg:#7c2d1255 fg:#fb923c',
        '.row': 'display:flex gap:$2 align-items:center',
        '.col': 'display:flex flex-direction:column gap:$2',
    });
}

function login() {
    A('div', 'display:flex align-items:center justify-content:center h:100vh', () => {
        A('form', 'bg:$panel p:$4 r:8px w:360px border: 1px solid $border; display:flex flex-direction:column gap:$3',
            'submit=', (e: Event) => { e.preventDefault(); attemptLogin(); }, () => {
            A('h2#Lowlander Dashboard', 'm:0');
            A('label', () => {
                A('span#WebSocket URL', 'fg:$muted display:block mb:$1');
                A('input type=text bind=', A.ref($state, 'wsUrl'), 'w:100%');
            });
            A('label', () => {
                A('span#Password', 'fg:$muted display:block mb:$1');
                A('input type=password bind=', A.ref($state, 'password'), 'w:100% autofocus=');
            });
            A(() => {
                if ($state.loginError) A('div', 'fg:$danger', () => A('text=', $state.loginError));
            });
            A('button type=submit', () => {
                A(() => A($state.connected && !$state.authed ? 'text=Checking…' : 'text=Log in'));
            });
        });
    });
}

async function attemptLogin() {
    $state.loginError = '';
    saveSettings({ wsUrl: $state.wsUrl, password: $state.password });
    try {
        if (connection) (connection as any).ws?.close?.();
    } catch {}
    connection = new Connection<ServerExports>($state.wsUrl);
    api = connection.api;
    $state.connected = false;
    $state.authed = false;
    const proxy = api._dashboard($state.password);
    authProxy = proxy;
    try {
        await proxy.promise;
        $state.connected = true;
        $state.authed = true;
    } catch (err: any) {
        $state.loginError = err?.message || 'Login failed';
        $state.connected = false;
        $state.authed = false;
        connection = undefined;
        api = undefined;
        authProxy = undefined;
    }
}

function logout() {
    $state.authed = false;
    $state.password = '';
    saveSettings({ wsUrl: $state.wsUrl, password: '' });
    try { (connection as any)?.ws?.close?.(); } catch {}
    connection = undefined;
    api = undefined;
    authProxy = undefined;
}

function sidebar() {
    A('aside', 'w:280px bg:$panel border-right: 1px solid $border; display:flex flex-direction:column overflow:hidden', () => {
        A('div', 'p:$3 border-bottom: 1px solid $border; display:flex justify-content:space-between align-items:center', () => {
            A('strong#Lowlander');
            A('button.ghost#Logout click=', () => logout());
        });
        A('nav', 'display:flex p:$2 gap:$1 border-bottom: 1px solid $border;', () => {
            for (const [key, label] of [['models', 'Models'], ['api', 'API'], ['streams', 'Streams'], ['debug', 'Debug']] as const) {
                A('button click=', () => $state.section = key, () => {
                    A(() => {
                        const active = $state.section === key;
                        A('text=', label);
                        A(active ? '.active' : '', active ? 'bg:$accent fg:#0b1220' : 'bg:transparent fg:$fg border:1px solid $border');
                    });
                });
            }
        });
        A('div', 'overflow:auto flex:1 p:$2', () => {
            if ($state.section === 'models') sidebarModels();
            else if ($state.section === 'api') sidebarApi();
            else if ($state.section === 'streams') A('div fg:$muted p:$2', 'text=Active streams');
            else A('div fg:$muted p:$2', 'text=Debug topics');
        });
    });
}

function sidebarModels() {
    const $models = authProxy!.serverProxy.listModels();
    A(() => {
        if ($models.busy) { A('div fg:$muted#Loading…'); return; }
        if ($models.error) { A('div fg:$danger', 'text=', $models.error.message); return; }
        const list = $models.value || [];
        for (const m of list) {
            A('div', 'p:6px 8px r:4px cursor:pointer',
                'click=', () => { $state.selectedModel = m.tableName; $state.selectedIndex = '(primary)'; $state.selectedMethod = ''; },
                () => {
                    A(() => {
                        const active = $state.selectedModel === m.tableName;
                        A(active ? 'bg:$panel2' : '');
                    });
                    A('div', 'display:flex justify-content:space-between align-items:baseline', () => {
                        A('span', 'text=', m.tableName);
                        A('span.tag', 'text=', `${m.fieldCount}f ${m.indexCount}i ${m.streamTypeCount}s`);
                    });
                });
        }
    });
}

function sidebarApi() {
    const $methods = authProxy!.serverProxy.listApiMethods();
    A(() => {
        if ($methods.busy) { A('div fg:$muted#Loading…'); return; }
        if ($methods.error) { A('div fg:$danger', 'text=', $methods.error.message); return; }
        const list = $methods.value || [];
        for (const m of list) {
            A('div', 'p:6px 8px r:4px cursor:pointer',
                'click=', () => { $state.selectedMethod = m.name; $state.selectedModel = ''; },
                () => {
                    A(() => {
                        if ($state.selectedMethod === m.name) A('bg:$panel2');
                    });
                    A('span', 'text=', m.name);
                    A('span.tag', 'text=', m.kind);
                });
        }
    });
}

function mainArea() {
    A('main', 'flex:1 overflow:auto p:$4', () => {
        if ($state.section === 'models' && $state.selectedModel) modelDetail();
        else if ($state.section === 'api' && $state.selectedMethod) methodDetail();
        else if ($state.section === 'streams') streamsView();
        else if ($state.section === 'debug') debugView();
        else A('div fg:$muted#Select an item from the sidebar', 'p:$4 text-align:center');
    });
}

function modelDetail() {
    const name = $state.selectedModel;
    const $info = authProxy!.serverProxy.getModel(name);
    A(() => {
        if ($info.busy) { A('div fg:$muted#Loading…'); return; }
        if ($info.error) { A('div fg:$danger', 'text=', $info.error.message); return; }
        const m = $info.value;
        if (!m) return;

        A('h2', 'm:0 mb:$2', 'text=', m.tableName);

        A('section', 'mb:$4', () => {
            A('h3#Fields', 'm:0 mb:$2 fg:$muted font-weight:600');
            A('table', () => {
                A('thead tr', () => { A('th#Name'); A('th#Type'); A('th#Linked'); A('th#Default'); A('th#Description'); });
                A('tbody', () => {
                    for (const f of m.fields) {
                        A('tr', () => {
                            A('td', () => A('code', 'text=', f.name));
                            A('td', 'fg:$accent2', 'text=', f.type.display);
                            A('td', () => { const lm = f.type.linkedModel; if (lm) A('a', 'href=#', 'click=', (e: Event) => { e.preventDefault(); $state.selectedModel = lm; $state.selectedIndex = '(primary)'; }, 'text=', lm); });
                            A('td', 'text=', f.hasDefault ? '✓' : '');
                            A('td', 'fg:$muted', 'text=', f.description || '');
                        });
                    }
                });
            });
        });

        A('section', 'mb:$4', () => {
            A('h3#Indexes', 'm:0 mb:$2 fg:$muted font-weight:600');
            A('div', 'display:flex flex-wrap:wrap gap:$2 mb:$3', () => {
                for (const idx of m.indexes) {
                    A('button', 'click=', () => $state.selectedIndex = idx.name, () => {
                        A(() => {
                            const active = $state.selectedIndex === idx.name;
                            A(active ? 'bg:$accent fg:#0b1220' : 'bg:$panel2 fg:$fg border: 1px solid $border;');
                        });
                        A('span', 'text=', idx.name);
                        A('span.tag', 'text=', idx.info.kind);
                        A('span.tag', 'text=', `[${idx.info.fields.join(', ') || 'computed'}]`);
                    });
                }
            });
            if ($state.selectedIndex) indexBrowser(name, $state.selectedIndex);
        });

        if (m.streamTypes.length) A('section', 'mb:$4', () => {
            A('h3#Stream types', 'm:0 mb:$2 fg:$muted font-weight:600');
            A('table', () => {
                A('thead tr', () => { A('th#id'); A('th#cache'); A('th#fields'); });
                A('tbody', () => {
                    for (const st of m.streamTypes) {
                        A('tr', () => {
                            A('td', () => A('code', 'text=', String(st.id)));
                            A('td', 'text=', st.cache ? `${st.cache}s` : '–');
                            A('td', () => A('pre', 'text=', JSON.stringify(st.fields, null, 2)));
                        });
                    }
                });
            });
        });
    });
}

function indexBrowser(modelName: string, indexName: string) {
    A('div', 'col bg:$panel p:$3 r:6px border: 1px solid $border;', () => {
        A('div', 'row flex-wrap:wrap gap:$2', () => {
            A('label', () => { A('span fg:$muted mr:$1#search'); A('input type=text bind=', A.ref($state, 'indexSearch')); });
            A('label', () => { A('span fg:$muted mr:$1#from'); A('input type=text bind=', A.ref($state, 'indexFrom')); });
            A('label', () => { A('span fg:$muted mr:$1#to'); A('input type=text bind=', A.ref($state, 'indexTo')); });
            A('label', () => { A('input type=checkbox bind=', A.ref($state, 'indexReverse'), '#reverse'); });
        });

        const opts = {
            from: parseMaybe($state.indexFrom),
            to: parseMaybe($state.indexTo),
            reverse: $state.indexReverse,
            search: $state.indexSearch || undefined,
            limit: 50,
        };
        const $rows = authProxy!.serverProxy.findRecords(modelName, indexName, opts);
        A(() => {
            if ($rows.busy) { A('div fg:$muted mt:$2#Loading…'); return; }
            if ($rows.error) { A('div fg:$danger mt:$2', 'text=', $rows.error.message); return; }
            const r = $rows.value;
            if (!r) return;
            A('div fg:$muted mt:$2', 'text=', `${r.rows.length} rows, scanned ${r.scanned}${r.truncatedScan ? '+' : ''}`);
            A('div', 'overflow:auto mt:$2', () => {
                A('table', () => {
                    const cols = r.rows.length ? Object.keys(r.rows[0].values) : [];
                    A('thead tr', () => { for (const c of cols) A('th', 'text=', c); });
                    A('tbody', () => {
                        for (const row of r.rows) {
                            A('tr', () => {
                                for (const c of cols) {
                                    const v = (row.values as any)[c];
                                    A('td', () => A('code', 'text=', typeof v === 'string' ? v : JSON.stringify(v)));
                                }
                            });
                        }
                    });
                });
            });
        });
    });
}

function parseMaybe(s: string): any {
    if (s === '') return undefined;
    if (s === 'true') return true; if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    try { return JSON.parse(s); } catch {}
    return s;
}

function methodDetail() {
    const name = $state.selectedMethod;
    const $src = authProxy!.serverProxy.getApiMethodSource(name);
    A('h2', 'm:0 mb:$2', () => A('code', 'text=', name));
    A(() => {
        if ($src.busy) { A('div fg:$muted#Loading…'); return; }
        if ($src.value === undefined) { A('div fg:$muted#No source available'); return; }
        A('pre', 'text=', $src.value);
    });
    A('div fg:$muted mt:$3#Note: full type signatures are not available at runtime.');
}

function streamsView() {
    const $streams = authProxy!.serverProxy.getActiveModelStreams();
    A('h2#Active model streams', 'm:0 mb:$2');
    A(() => {
        if ($streams.busy) { A('div fg:$muted#Loading…'); return; }
        if ($streams.error) { A('div fg:$danger', 'text=', $streams.error.message); return; }
        const list = $streams.value || [];
        if (!list.length) { A('div fg:$muted#No active model streams'); return; }
        A('table', () => {
            A('thead tr', () => { A('th#Stream channel id'); A('th#Subscribers'); });
            A('tbody', () => {
                for (const s of list) {
                    A('tr', () => {
                        A('td', () => A('code', 'text=', String(s.streamTypeId)));
                        A('td', 'text=', String(s.subscribers));
                    });
                }
            });
        });
    });
}

function debugView() {
    const $mode = A.proxy({v: 'channels' as 'channels' | 'sockets' | 'workers' | 'kv'});
    A('div', 'row mb:$3', () => {
        for (const t of ['channels','sockets','workers','kv'] as const) {
            A('button click=', () => $mode.v = t, () => {
                A(() => A($mode.v === t ? 'bg:$accent fg:#0b1220' : 'bg:$panel2 fg:$fg border: 1px solid $border;'));
                A('text=', t);
            });
        }
    });
    A(() => {
        const $debug = authProxy!.serverProxy.getDebugState($mode.v);
        A(() => {
            if ($debug.busy) { A('div fg:$muted#Loading…'); return; }
            if ($debug.error) { A('div fg:$danger', 'text=', $debug.error.message); return; }
            A('pre', 'text=', JSON.stringify($debug.value, replacer, 2));
        });
    });
}

function replacer(_: string, v: any) {
    if (v && typeof v === 'object' && v.type === 'Buffer') return v;
    if (v instanceof Uint8Array || (v && v.constructor && v.constructor.name === 'Uint8Array')) {
        try { return '0x' + Array.from(v as Uint8Array).map((b: number) => b.toString(16).padStart(2,'0')).join(''); } catch { return v; }
    }
    return v;
}

styles();
A.mount(document.body, () => {
    if (!$state.authed) { login(); return; }
    A('div', 'display:flex flex-direction:row h:100vh w:100vw overflow:hidden', () => {
        sidebar();
        mainArea();
    });
});
