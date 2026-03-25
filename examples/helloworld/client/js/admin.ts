import 'mdui/mdui.css';
import 'mdui/components/button.js';
import 'mdui/components/dialog.js';
import 'mdui/components/tabs.js';
import 'mdui/components/tab.js';
import 'mdui/components/tab-panel.js';
import type { Dialog } from 'mdui/components/dialog.js';

import A from "aberdeen";
import { ClientProxyObject } from 'lowlander/client';
import type * as ServerAPI from '../../server/api.js';
type API = ClientProxyObject<typeof ServerAPI>;

const TOPICS = ['sockets', 'channels', 'workers', 'kv'] as const;

function formatDecodedBytes(value: Uint8Array) {
    let text = '';
    for (const byte of value) {
        const codePoint = byte;
        const char = String.fromCodePoint(codePoint);
        const printableAscii = codePoint >= 0x20 && codePoint <= 0x7e;
        const whitespace = codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d;
        text += printableAscii || whitespace ? char : `<${codePoint}>`;
    }
    return text;
}

const tableStyle = A.insertCss({
    '&': 'border-collapse:collapse text-align:left box-shadow: 0 0 20px rgba(0, 0, 0, 0.15);',
    'tr:nth-child(even)': 'background-color:#0002;',
    'td,th': 'padding: $1 $2; border-left: 1px solid #0002;',
    'td:first-child,th:first-child': 'border-left:none',
})

export function showAdminModal(api: API) {

    const refreshes = A.proxy(0);
    const closed = A.proxy(false);
    A.mount(document.body, () => {
        if (A.peek(closed, 'value') || closed.value) return;
        A('mdui-dialog open= close-on-overlay-click= close-on-esc= headline="Lowlander Admin panel" closed=', () => closed.value = true, () => {
            A('span slot=description mdui-tabs value=', TOPICS[0], () => {
                for(const topic of TOPICS) {
                    A('mdui-tab value=',topic, 'text=',topic);
                }

                for(const topic of TOPICS) {
                    A('mdui-tab-panel slot=panel value=', topic, () => {
                        const sockets = api.getDebugState(topic as any);
                        refreshes.value;
                        A(() => {
                                const data = A.unproxy(sockets.value) as undefined | Record<string, Record<string, any>> | Record<string, any>[];
                                if (!data) return;
                                const keySet = new Set<string>();
                                for (const [, obj] of Object.entries(data)) {
                                    if (obj && typeof obj === 'object' && !(obj instanceof Uint8Array))
                                        for (const k of Object.keys(obj)) keySet.add(k);
                                }
                                const cols = [...keySet];
                                A('table', tableStyle, () => {
                                    A('tr', () => {
                                        A('th text=#');
                                        for (const k of cols) A('th text=', k);
                                    });
                                    for (const [idx, obj] of Object.entries(data)) {
                                        A('tr', () => {
                                            A('td text=', idx);
                                            for (const k of cols) {
                                                const value = obj?.[k];
                                                let text = '';
                                                if (value instanceof Uint8Array) {
                                                    text = formatDecodedBytes(value);
                                                }
                                                else if (value !== null && value !== undefined) {
                                                    text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                                                        ? String(value)
                                                        : JSON.stringify(value);
                                                }
                                                A('td text=', text);
                                            }
                                        });
                                    }
                                });
                            });
                    });
                }
            });

            const dialog = A() as Dialog;
            A('mdui-button slot=action variant=text text=Update click=', () => refreshes.value++);
            A('mdui-button slot=action variant=text text=Close click=', () => dialog.open = false);
        })
    })
}
