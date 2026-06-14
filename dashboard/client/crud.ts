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
 * Draw the standard Staffa field chrome (a `.s-field` wrapper with a label)
 * around a caller-supplied control. Composite editors (link/collection/record/
 * optional/enum) use this so their labels match Staffa's own form fields.
 *
 * Staffa doesn't export its internal `drawField`, but the `.s-field` CSS class
 * (and its `> label` rule) is registered globally, so reusing the class gives us
 * the exact same styling.
 */
function drawFieldChrome(label: string | undefined, drawControl: () => void) {
    A('div.s-field', () => {
        if (label != null) A('label', () => A('#', label));
        drawControl();
    });
}

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

        case 'or': {
            // A union of literals is an enum → render as a segmented chooser.
            const choices = type.choices ?? [];
            if (choices.length && choices.every(c => c.kind === 'literal')) {
                renderEnumEditor(choices, $bind, label, readOnly);
                return;
            }
            // General union: fall back to raw JSON textarea
            renderJsonEditor($bind, label, readOnly);
            return;
        }

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
    // $mode ('set' | 'undefined') tracks enabled state independently from $bind so
    // the inner editor scope doesn't re-run (and lose focus) on every value change.
    // Peek the initial value so the enclosing scope doesn't subscribe to it.
    const initiallySet = A.peek(() => $bind.value !== null && $bind.value !== undefined);
    const $mode = A.proxy({ v: initiallySet ? 'set' : 'undefined' });

    // One-way sync: $mode.v → $bind.value.
    // Uses A.peek to read $bind.value without subscribing (avoids circular loop).
    A(() => {
        if ($mode.v === 'set') {
            if (A.peek(() => $bind.value) === null || A.peek(() => $bind.value) === undefined) {
                $bind.value = defaultEditValue(innerType);
            }
        } else {
            $bind.value = null;
        }
    });

    drawFieldChrome(label, () => {
        S.buttonChooser({
            attrs: readOnly ? 'pointer-events:none opacity:0.6' : undefined,
            options: { set: 'set', undefined: 'undefined' },
            bind: A.ref($mode, 'v'),
        });
        // Inner editor: depends on $mode.v, NOT on $bind.value — so typing
        // in a text field inside the optional editor won't recreate the DOM.
        A(() => {
            if ($mode.v !== 'set') return;
            renderFieldEditor(innerType, $bind, proxy, undefined, readOnly);
        });
    });
}

/**
 * Render a union of literal values (an enum) as a segmented buttonChooser.
 * Each literal's JSON-serialised form (TypeInfo.literalValue) is used as the
 * button id; the `undefined` literal becomes a "(none)" choice.
 */
function renderEnumEditor(
    choices: TypeInfo[],
    $bind: { value: any },
    label?: string,
    readOnly = false,
) {
    const idForValue = (v: any): string | null =>
        v === null || v === undefined ? 'undefined' : JSON.stringify(v);
    const valueForId = (id: string | null): any =>
        id === null || id === 'undefined' ? null : JSON.parse(id);

    const options: Record<string, string> = {};
    let hasNone = false;
    for (const c of choices) {
        const id = c.literalValue ?? 'undefined';
        if (id === 'undefined') { hasNone = true; options[id] = '(none)'; }
        else options[id] = String(valueForId(id));
    }

    const $sel = A.proxy({ v: idForValue(A.peek(() => $bind.value)) });

    // One-way: $sel.v → $bind.value (reads $sel only, so no circular loop).
    A(() => { $bind.value = valueForId($sel.v); });

    drawFieldChrome(label, () => {
        S.buttonChooser({
            attrs: readOnly ? 'pointer-events:none opacity:0.6' : undefined,
            options,
            bind: A.ref($sel, 'v'),
            // Without an explicit "(none)" choice, allow clearing back to null.
            allowDeselect: !hasNone,
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

    // Load candidate records ONCE into a stable proxy. The outer scope has no
    // reactive dependencies, so findRecords runs a single time; the inner scope
    // copies the rows over once the RPC resolves. (Calling findRecords directly
    // inside the autocomplete's reactive options() refetched on every settle and
    // never produced a stable result — hence the perpetual "No matches".)
    const $opts = A.proxy({ rows: [] as any[] });
    A(() => {
        const result = proxy.serverProxy.findRecords(linkedModel, '(primary)', { limit: 100 });
        A(() => { if (result.value) $opts.rows = result.value.rows; });
    });

    S.autocomplete({
        label,
        disabled: readOnly,
        allowCustom: false,
        placeholder: `Search ${linkedModel}…`,
        bind: A.ref($acStr, 'v'),
        // The autocomplete filters these client-side by label as the user types.
        options: () => ($opts.rows as any[]).map((row: any) => ({
            value: jsonStringify(row.pk),
            label: jsonStringify(row.pk),
        })),
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

    // Build the local state WITHOUT subscribing the enclosing scope. Every read
    // here (the initial value, its elements, the new proxy's length) must happen
    // inside A.peek — otherwise, when this editor renders inside a reactive scope
    // such as S.form's content, reading $items.length would subscribe that scope
    // and pushing/removing items would re-run it, wiping this local state.
    const [$items, $len] = A.peek(() => {
        const initVal = $bind.value;
        const initArr: any[] = Array.isArray(initVal) ? initVal : [];
        // Stable per-item proxies: the item editors write to $items[i].v, which
        // syncs back to $bind.value via a one-way reactive block.
        const items = A.proxy(initArr.map((v: any) => ({ v })));
        // Count proxy: drives add/remove re-renders without coupling to item values.
        const len = A.proxy({ v: (items as any[]).length });
        return [items, len] as const;
    });

    // One-way sync: item proxies → $bind.value (never reads $bind.value so no loop)
    A(() => { $bind.value = ($items as any[]).map((item: any) => item.v); });

    drawFieldChrome(label, () => {
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

    // Build local state without subscribing the enclosing scope (see
    // renderCollectionEditor for why every read must be inside A.peek).
    const [$entries, $eLen] = A.peek(() => {
        const initVal = $bind.value;
        const initObj: Record<string, any> =
            initVal && typeof initVal === 'object' && !Array.isArray(initVal) ? initVal : {};
        // Stable per-entry proxies (same pattern as renderCollectionEditor).
        const entries = A.proxy(Object.entries(initObj).map(([k, v]) => ({ k, v })));
        const len = A.proxy({ v: (entries as any[]).length });
        return [entries, len] as const;
    });

    // Entries with a blank key are skipped; on duplicate keys the last one wins.
    A(() => {
        const obj: Record<string, any> = {};
        for (const e of ($entries as any[])) {
            if (e.k === '') continue;
            obj[e.k] = e.v;
        }
        $bind.value = obj;
    });

    drawFieldChrome(label, () => {
        A('div.s-s.raised', 'display:flex flex-direction:column gap:$4 p:$2 r:$s-radius-lg border: 1px solid $s-border;', () => {
            A(() => {
                const len: number = $eLen.v;
                if (len === 0) A('span', 'fg:$s-fg-faint font-size:0.9em', '#(empty)');
                for (let i = 0; i < len; i++) {
                    const idx = i;
                    A('div', 'display:flex flex-direction:column gap:$1', () => {
                        // Key row: key field + delete button
                        A('div', 'display:flex gap:$2 align-items:center', () => {
                            if (readOnly) {
                                A('code', 'flex:1 font-size:0.85em fg:$s-fg-muted', '#', A.peek(() => ($entries as any)[idx].k));
                            } else {
                                A('div', 'flex:1', () => {
                                    S.textline({ placeholder: 'key', bind: A.ref(($entries as any)[idx], 'k') });
                                });
                            }
                            if (!readOnly) {
                                S.button({
                                    text: '×', attrs: '.outlined.danger .small flex-shrink:0', click: () => {
                                    ($entries as any[]).splice(idx, 1);
                                    $eLen.v = ($entries as any[]).length;
                                }});
                            }
                        });
                        // Value row
                        A('div', () => {
                            const $item = A.ref(($entries as any)[idx], 'v');
                            renderFieldEditor(valueType, $item, proxy, undefined, readOnly);
                        });
                    });
                }
            });

            if (!readOnly) {
                S.button({
                    text: '+ Add entry',
                    attrs: '.tonal .small',
                    click: () => {
                        ($entries as any[]).push({ k: '', v: defaultEditValue(valueType) });
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

function openFormDialog(
    proxy: ServerProxy,
    header: string,
    fields: FieldInfo[],
    initValue: (f: FieldInfo) => any,
    isReadOnly: (f: FieldInfo) => boolean,
    submitText: string,
    onSubmit: (boxes: Record<string, { v: any }>, close: () => void) => Promise<void>,
) {
    const boxes: Record<string, { v: any }> = {};
    for (const f of fields) {
        boxes[f.name] = A.proxy({ v: initValue(f) });
    }

    const $status = A.proxy({ saving: false });

    S.dialog({
        header,
        attrs: "width:800px",
        content: (close) => {
            S.form({
                content: () => {
                    for (const f of fields) {
                        renderFieldEditor(f.type, A.ref(boxes[f.name]!, 'v'), proxy, f.name, isReadOnly(f));
                    }
                },
                layout: "grid",
                actions: () => {
                    S.button({ text: 'Cancel', attrs: '.outlined.neutral', click: close });
                    A(() => {
                        S.button({
                            text: submitText,
                            type: 'button',
                            disabled: $status.saving,
                            click: async () => {
                                $status.saving = true;
                                try {
                                    await onSubmit(boxes, close);
                                } catch (err: any) {
                                    S.toast({ message: err?.message ?? String(err), type: 'danger' });
                                } finally {
                                    $status.saving = false;
                                }
                            },
                        });
                    });
                },
            });
        },
    });
}

export function openCreateModal(
    proxy: ServerProxy,
    modelName: string,
    fields: FieldInfo[],
    onCreated?: (pk: any) => void,
) {
    const editableFields = fields.filter(f => f.type.kind !== 'id');
    openFormDialog(
        proxy,
        `New ${modelName}`,
        editableFields,
        (f) => defaultEditValue(f.type),
        () => false,
        'Create',
        async (boxes, close) => {
            const payload: Record<string, any> = {};
            for (const f of editableFields) payload[f.name] = boxes[f.name]!.v;
            const pk = await proxy.serverProxy.createRecord(modelName, payload).promise;
            close();
            onCreated?.(pk);
        },
    );
}

export function openEditModal(
    proxy: ServerProxy,
    modelName: string,
    fields: FieldInfo[],
    pk: any,
    currentValues: Record<string, any>,
    onSaved?: () => void,
) {
    openFormDialog(
        proxy,
        `Edit ${modelName}`,
        fields,
        (f) => toEditValue(f.type, currentValues[f.name]),
        (f) => f.isPk,
        'Save',
        async (boxes, close) => {
            const payload: Record<string, any> = {};
            for (const f of fields) {
                if (!f.isPk) payload[f.name] = boxes[f.name]!.v;
            }
            await proxy.serverProxy.updateRecord(modelName, pk, payload).promise;
            close();
            onSaved?.();
        },
    );
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
                            await proxy.serverProxy.deleteRecord(modelName, pk).promise;
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
