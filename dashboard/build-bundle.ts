#!/usr/bin/env node
// Bundles dashboard/client/main.ts into build/dashboard/dashboard.html as a
// single self-contained file.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'build/dashboard');
mkdirSync(outDir, { recursive: true });

const result = await esbuild.build({
    entryPoints: [resolve(here, 'client/main.ts')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    minify: true,
    sourcemap: false,
    write: false,
    tsconfig: resolve(root, 'tsconfig.client.json'),
});
if (result.errors.length) {
    for (const e of result.errors) console.error(e.text);
    process.exit(1);
}
const js = result.outputFiles[0].text;

const template = readFileSync(resolve(here, 'client/index.html'), 'utf8');
const html = template.replace(
    '<!--LOWLANDER_DASHBOARD_SCRIPT-->',
    `<script type="module">${js.replace(/<\/script>/gi, '<\\/script>')}</script>`,
);

const outFile = resolve(outDir, 'dashboard.html');
writeFileSync(outFile, html);
console.log(`Dashboard bundled: ${outFile} (${(html.length / 1024).toFixed(1)} KB)`);
