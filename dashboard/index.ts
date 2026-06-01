export { _dashboard } from './server.js';
export type { DashboardAPI } from './server.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import type { ServerResponse } from 'http';
import type { HttpResponse } from 'warpsocket';

const HERE = dirname(fileURLToPath(import.meta.url));
// Bundle lives next to the compiled serve.js (build/dashboard/dashboard.html);
// when running from TS source under Bun, fall back to ../build/dashboard/.
const CANDIDATES = [
    resolve(HERE, 'dashboard.html'),
    resolve(HERE, '../build/dashboard/dashboard.html'),
];

let cachedHtml: string | undefined;
function getHtml(): string {
    if (cachedHtml === undefined) {
        let lastErr: any;
        for (const p of CANDIDATES) {
            try { cachedHtml = readFileSync(p, 'utf8'); break; } catch (e) { lastErr = e; }
        }
        if (cachedHtml === undefined) {
            cachedHtml = `<!doctype html><html><body><pre>Dashboard bundle missing: ${lastErr?.message || lastErr}\n\nDid you run \`npm run build\` in the lowlander package?</pre></body></html>`;
        }
    }
    return cachedHtml;
}

/**
 * Serve the bundled dashboard HTML on an HTTP response. Compatible with
 * Node.js `http.ServerResponse`, Bun's node-compat response, and
 * warpsocket's `HttpResponse`. Wire into e.g.:
 *
 * ```ts
 * import { serveDashboard } from 'lowlander/dashboard';
 * export function handleHttpRequest(req, res) {
 *   if (req.url === '/_dashboard') return serveDashboard(res);
 * }
 * ```
 */
export function serveDashboard(res: ServerResponse | HttpResponse): void {
    const html = getHtml();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(html);
}
