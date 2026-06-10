/**
 * CRUD row editor for the Lowlander dashboard.
 *
 * Provides openEditModal, openCreateModal, and openDeleteConfirm, each of
 * which opens a Staffa modal to let the user create, edit or delete a record.
 * Field editors are chosen recursively based on Edinburgh TypeInfo descriptors.
 */
import A from 'aberdeen';
import S from 'staffa';
import type { ClientProxyObject } from 'lowlander/client';
import type { TypeInfo, DashboardAPI } from '../server.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type ServerProxy = { serverProxy: ClientProxyObject<DashboardAPI> };

export interface FieldInfo {
    name: string;
    type: TypeInfo;
    description?: string;
    hasDefault: boolean;
    isPk: boolean;
}

// ─── Value conversion helpers ─────────────────────────────────────────────

/**
 * Convert a display-serialised value (from serializeValue on the server) into
 * an editor-friendly form. The editor sends these back to the server, which
 * runs parseValueFromJson to reconstruct the Edinburgh value.
 */
function toEditValue(type: TypeInfo, value: any): any {
    if (value === null || value === undefined) return null;
    switch (type.kind) {
        case 'dateTime':
            // ISO → datetime-local (slice to "YYYY-MM-DDTHH:MM")
            if (typeof value === 'string') return value.slice(0, 16);
            return value;
        case 'link':
            // { __ref, pk } → just pk (server knows the type)
            return value?.__ref != null ? value.pk : value;
        case 'array':
        case 'set':
            if (!Array.isArray(value)) return [];
            return value.map((v: any) => toEditValue(type.inner!, v));
        case 'record':
            if (!value || typeof value !== 'object') return {};
            const out: Record<string, any> = {};
            for (const [k, v] of Object.entries(value)) out[k] = toEditValue(type.innerValue!, v);
            return out;
        case 'or':
            if (type.isOptional && type.inner) {
                return value === null ? null : toEditValue(type.inner, value);
            }
            return value;
        default:
            return value;
    }
}

/** Default edit value for a type when creating a new record. */
function defaultEditValue(type: TypeInfo): any {
    if (type.isOptional) return null;
    switch (type.kind) {
        case 'string':     return '';
        case 'number':     return 0;
        case 'boolean':    return false;
        case 'dateTime':   return new Date().toISOString().slice(0, 16);
        case 'array':
        case 'set':        return [];
        case 'record':     return {};
        case 'link':       return null;
        case 'or':
        case 'literal':    return null;
        default:           return '';
    }
}

// ─── Inline field editors ─────────────────────────────────────────────────

/**
 * Render an appropriate input widget for the given TypeInfo.
 * $bind.value holds/receives the edit-format value.
 */
function renderFieldEditor(
    type: TypeInfo,
    $bind: { value: any },
    proxy: ServerProxy,
    label?: string,
    readOnly = false,
) {
    // Unwrap opt(T) → checkbox + inner editor
    if (type.isOptional && type.inner) {
        renderOptionalEditor(type.inner, $bind, proxy, label, readOnly);
        return;
    }

    switch (type.kind) {
        case 'string':
            S.textline({ label, disabled: readOnly, bind: $bind });
            return;

        case 'id':
            S.textline({ label, disabled: true, bind: $bind,
                help: readOnly ? 'auto-generated' : undefined });
            return;

        case 'number':
            S.textline({ label, type: 'number', disabled: readOnly, bind: $bind });
            return;

        case 'boolean':
            S.checkbox({ label: label ?? 'Yes', disabled: readOnly, bind: $bind });
            return;

        case 'dateTime':
            S.textline({ label, type: 'datetime-local', disabled: readOnly, bind: $bind });
            return;

        case 'link':
            renderLinkEditor(type, $bind, proxy, label, readOnly);
            return;

        case 'array':
        case 'set':
            renderCollectionEditor(type, $bind, proxy, label, readOnly);
            return;

        case 'record':
            renderRecordEditor(type, $bind, proxy, label, readOnly);
            return;

        case 'or':
            // General union: fall back to raw JSON textarea
            renderJsonEditor($bind, label, readOnly);
            return;

        case 'literal':
            // Read-only — show value as disabled text
            S.textline({ label, disabled: true, value: type.literalValue ?? '' });
            return;

        default:
            renderJsonEditor($bind, label, readOnly);
    }
}

function renderOptionalEditor(
    innerType: TypeInfo,
    $bind: { value: any },
    proxy: ServerProxy,
    label?: string,
    readOnly = false,
) {
    // $isSet tracks enabled state independently from $bind so the inner
    // editor scope doesn't re-run (and lose focus) on every value change.
    const $isSet = A.proxy({ v: $bind.value !== null && $bind.value !== undefined });

    // One-way sync: $isSet.v → $bind.value.
    // Uses A.peek to read $bind.value without subscribing (avoids circular loop).
    A(() => {
        const on = $isSet.v;
        if (on) {
            if (A.peek(() => $bind.value) === null || A.peek(() => $bind.value) === undefined) {
                $bind.value = defaultEditValue(innerType);
            }
        } else {
            $bind.value = null;
        }
    });

    A('div', () => {
        // Label + toggle row — checkbox uses A.ref so Aberdeen's bind= works
        A('div', 'display:flex align-items:center gap:$2 mb:$1', () => {
            if (label) A('span', 'fg:$s-fg-muted font-size:0.85em font-weight:600 text-transform:uppercase letter-spacing:0.04em', '#', label);
            S.checkbox({ label: 'set', disabled: readOnly, bind: A.ref($isSet, 'v') });
        });
        // Inner editor: depends on $isSet.v, NOT on $bind.value — so typing
        // in a text field inside the optional editor won't recreate the DOM.
        A(() => {
            if (!$isSet.v) return;
            renderFieldEditor(innerType, $bind, proxy, undefined, readOnly);
        });
    });
}

function renderLinkEditor(
    type: TypeInfo,
    $bind: { value: any },
    proxy: ServerProxy,
    label?: string,
    readOnly = false,
) {
    const linkedModel = type.linkedModel;
    if (!linkedModel) {
        renderJsonEditor($bind, label, readOnly);
        return;
    }

    // The autocomplete needs a real proxy Bindable holding a string. We keep a
    // display proxy ($acStr) and one-way sync it back to $bind (string → pk).
    const initial = A.peek(() => $bind.value);
    const $acStr = A.proxy({ v: initial === null || initial === undefined ? '' : String(initial) });

    // One-way: $acStr.v → $bind.value. Reads $acStr only (writes $bind), no loop.
    A(() => {
        const s = $acStr.v;
        if (s === '') {
            $bind.value = null;
        } else {
            const asNum = Number(s);
            $bind.value = !isNaN(asNum) && !/[^0-9.\-]/.test(s) ? asNum : s;
        }
    });

    S.autocomplete({
        label,
        disabled: readOnly,
        allowCustom: false,
        placeholder: `Search ${linkedModel}…`,
        bind: A.ref($acStr, 'v'),
        options: () => {
            const result = proxy.serverProxy.findRecords(linkedModel, '(primary)', {
                limit: 20,
            });
            if (!result.value) return [];
            return result.value.rows.map((row: any) => ({
                value: jsonStringify(row.pk),
                label: `${linkedModel}: ${jsonStringify(row.pk)}`,
            }));
        },
    });
}

function renderCollectionEditor(
    type: TypeInfo,
    $bind: { value: any },
    proxy: ServerProxy,
    label?: string,
    readOnly = false,
) {
    const innerType = type.inner!;

    // Read the initial value WITHOUT subscribing (A.peek) so this editor's
    // host scope never re-runs when we write $bind.value back below.
    const initVal = A.peek(() => $bind.value);
    const initArr: any[] = Array.isArray(initVal) ? initVal : [];

    // Stable per-item proxies: the item editors write to $items[i].v, which
    // syncs back to $bind.value via a one-way reactive block.
    const $items = A.proxy(initArr.map((v: any) => ({ v })));

    // One-way sync: item proxies → $bind.value (never reads $bind.value so no loop)
    A(() => { $bind.value = ($items as any[]).map((item: any) => item.v); });

    // Count proxy: drives add/remove re-renders without coupling to item values
    const $len = A.proxy({ v: ($items as any[]).length });

    A('div', () => {
        if (label) A('label', 'display:block fg:$s-fg-muted font-size:0.85em font-weight:600 text-transform:uppercase letter-spacing:0.04em mb:$1', '#', label);

        A('div.s-s.raised', 'display:flex flex-direction:column gap:$2 p:$2 r:$s-radius-lg border: 1px solid $s-border;', () => {
            A(() => {
                const len: number = $len.v;
                if (len === 0) {
                    A('span', 'fg:$s-fg-faint font-size:0.9em', '#(empty)');
                }
                for (let i = 0; i < len; i++) {
                    const idx = i;
                    A('div', 'display:flex gap:$2 align-items:flex-start', () => {
                        A('div', 'flex:1', () => {
                            // A.ref gives Aberdeen's bind= an actual proxy Bindable
                            const $item = A.ref(($items as any)[idx], 'v');
                            renderFieldEditor(innerType, $item, proxy, undefined, readOnly);
                        });
                        if (!readOnly) {
                            S.button({
                                text: '×',
                                attrs: '.outlined.danger .small flex-shrink:0 mt:$3',
                                click: () => {
                                    ($items as any[]).splice(idx, 1);
                                    $len.v = ($items as any[]).length;
                                },
                            });
                        }
                    });
                }
            });

            if (!readOnly) {
                S.button({
                    text: `+ Add ${innerType.display}`,
                    attrs: '.tonal .small',
                    click: () => {
                        ($items as any[]).push({ v: defaultEditValue(innerType) });
                        $len.v = ($items as any[]).length;
                    },
                });
            }
        });
    });
}

function renderRecordEditor(
    type: TypeInfo,
    $bind: { value: any },
    proxy: ServerProxy,
    label?: string,
    readOnly = false,
) {
    const valueType = type.innerValue!;

    // Read initial value without subscribing (see renderCollectionEditor).
    const initVal = A.peek(() => $bind.value);
    const initObj: Record<string, any> =
        initVal && typeof initVal === 'object' && !Array.isArray(initVal) ? initVal : {};

    // Stable per-entry proxies (same pattern as renderCollectionEditor)
    const $entries = A.proxy(Object.entries(initObj).map(([k, v]) => ({ k, v })));
    const $eLen = A.proxy({ v: ($entries as any[]).length });

    A(() => {
        const obj: Record<string, any> = {};
        for (const e of ($entries as any[])) obj[e.k] = e.v;
        $bind.value = obj;
    });

    A('div', () => {
        if (label) A('label', 'display:block fg:$s-fg-muted font-size:0.85em font-weight:600 text-transform:uppercase letter-spacing:0.04em mb:$1', '#', label);

        A('div.s-s.raised', 'display:flex flex-direction:column gap:$2 p:$2 r:$s-radius-lg border: 1px solid $s-border;', () => {
            A(() => {
                const len: number = $eLen.v;
                if (len === 0) A('span', 'fg:$s-fg-faint font-size:0.9em', '#(empty)');
                for (let i = 0; i < len; i++) {
                    const idx = i;
                    A('div', 'display:flex gap:$2 align-items:flex-start', () => {
                        A('code', 'flex-shrink:0 font-size:0.85em mt:$3 fg:$s-fg-muted', '#', ($entries as any)[idx].k);
                        A('div', 'flex:1', () => {
                            const $item = A.ref(($entries as any)[idx], 'v');
                            renderFieldEditor(valueType, $item, proxy, undefined, readOnly);
                        });
                        if (!readOnly) {
                            S.button({
                                text: '×', attrs: '.outlined.danger .small flex-shrink:0 mt:$3', click: () => {
                                ($entries as any[]).splice(idx, 1);
                                $eLen.v = ($entries as any[]).length;
                            }});
                        }
                    });
                }
            });

            if (!readOnly) {
                S.button({
                    text: '+ Add entry',
                    attrs: '.tonal .small',
                    click: async () => {
                        const newKey = await S.prompt('Key name:');
                        if (!newKey || ($entries as any[]).some((e: any) => e.k === newKey)) return;
                        ($entries as any[]).push({ k: newKey, v: defaultEditValue(valueType) });
                        $eLen.v = ($entries as any[]).length;
                    },
                });
            }
        });
    });
}

function renderJsonEditor($bind: { value: any }, label?: string, readOnly = false) {
    const initial = A.peek(() => $bind.value);
    const $str = A.proxy({ v: initial === undefined ? '' : jsonStringify(initial) });
    const $error = A.proxy({ v: '' });

    // One-way: $str.v → $bind.value. Writes $bind only, so no circular loop.
    A(() => {
        const s = $str.v;
        if (s.trim() === '') { $bind.value = undefined; $error.v = ''; return; }
        try {
            $bind.value = JSON.parse(s);
            $error.v = '';
        } catch {
            $error.v = 'Invalid JSON';
        }
    });

    // Textarea binds to a real proxy ref; error shown in its own scope so the
    // textarea is never recreated (which would lose focus on each keystroke).
    S.textarea({ label, disabled: readOnly, rows: 3, bind: A.ref($str, 'v') });
    A(() => {
        if ($error.v) A('div', 'fg:$s-danger font-size:0.82em mt:$1', '#', $error.v);
    });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function openCreateModal(
    proxy: ServerProxy,
    modelName: string,
    fields: FieldInfo[],
    onCreated?: (pk: any) => void,
) {
    const editableFields = fields.filter(f => f.type.kind !== 'id');
    // Each field value lives in a real Aberdeen proxy box, so leaf editors can
    // bind to A.ref(box, 'v') — Aberdeen's bind= requires a genuine proxy.
    const boxes: Record<string, { v: any }> = {};
    for (const f of editableFields) {
        boxes[f.name] = A.proxy({ v: defaultEditValue(f.type) });
    }

    const $status = A.proxy({ saving: false, error: '' });

    S.dialog({
        header: `New ${modelName}`,
        content: (close) => {
            S.form({
                content: () => {
                    for (const f of editableFields) {
                        renderFieldEditor(f.type, A.ref(boxes[f.name]!, 'v'), proxy, f.name, false);
                    }
                },
                actions: () => {
                    S.button({
                        text: 'Create',
                        type: 'button',
                        disabled: A.peek(() => $status.saving),
                        click: async () => {
                            $status.saving = true;
                            $status.error = '';
                            try {
                                const payload: Record<string, any> = {};
                                for (const f of editableFields) payload[f.name] = boxes[f.name]!.v;
                                const pk = await proxy.serverProxy.createRecord(modelName, payload);
                                close();
                                onCreated?.(pk);
                            } catch (err: any) {
                                $status.error = err?.message ?? String(err);
                                $status.saving = false;
                            }
                        },
                    });
                    S.button({ text: 'Cancel', attrs: '.outlined.neutral', click: close });
                    A(() => {
                        if ($status.error) A('span', 'fg:$s-danger font-size:0.85em', '#', $status.error);
                    });
                },
            });
        },
    });
}

export function openEditModal(
    proxy: ServerProxy,
    modelName: string,
    fields: FieldInfo[],
    pk: any,
    currentValues: Record<string, any>,
    onSaved?: () => void,
) {
    // Build per-field reactive boxes initialised from current values
    const boxes: Record<string, { v: any }> = {};
    for (const f of fields) {
        boxes[f.name] = A.proxy({ v: toEditValue(f.type, currentValues[f.name]) });
    }

    const $status = A.proxy({ saving: false, error: '' });

    S.dialog({
        header: `Edit ${modelName}`,
        content: (close) => {
            S.form({
                content: () => {
                    for (const f of fields) {
                        renderFieldEditor(f.type, A.ref(boxes[f.name]!, 'v'), proxy, f.name, f.isPk);
                    }
                },
                actions: () => {
                    S.button({
                        text: 'Save',
                        type: 'button',
                        disabled: A.peek(() => $status.saving),
                        click: async () => {
                            $status.saving = true;
                            $status.error = '';
                            try {
                                const payload: Record<string, any> = {};
                                for (const f of fields) {
                                    if (!f.isPk) payload[f.name] = boxes[f.name]!.v;
                                }
                                await proxy.serverProxy.updateRecord(modelName, pk, payload);
                                close();
                                onSaved?.();
                            } catch (err: any) {
                                $status.error = err?.message ?? String(err);
                                $status.saving = false;
                            }
                        },
                    });
                    S.button({ text: 'Cancel', attrs: '.outlined.neutral', click: close });
                    A(() => {
                        if ($status.error) A('span', 'fg:$s-danger font-size:0.85em', '#', $status.error);
                    });
                },
            });
        },
    });
}

export function openDeleteConfirm(
    proxy: ServerProxy,
    modelName: string,
    pk: any,
    displayLabel: string,
    onDeleted?: () => void,
) {
    const $status = A.proxy({ deleting: false, error: '' });

    S.dialog({
        header: `Delete ${modelName}`,
        content: (close) => {
            A('p', 'fg:$s-fg m:0', () => {
                A('#Delete ');
                A('strong', '#', displayLabel);
                A('#? This cannot be undone.');
            });
            A(() => {
                if ($status.error) A('p', 'fg:$s-danger m:0', '#', $status.error);
            });
            A('div', 'display:flex gap:$2 mt:$3', () => {
                S.button({
                    text: 'Delete',
                    attrs: '.danger',
                    disabled: A.peek(() => $status.deleting),
                    click: async () => {
                        $status.deleting = true;
                        $status.error = '';
                        try {
                            await proxy.serverProxy.deleteRecord(modelName, pk);
                            close();
                            onDeleted?.();
                        } catch (err: any) {
                            $status.error = err?.message ?? String(err);
                            $status.deleting = false;
                        }
                    },
                });
                S.button({ text: 'Cancel', attrs: '.outlined.neutral', click: close });
            });
        },
    });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function jsonStringify(v: any): string {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}
