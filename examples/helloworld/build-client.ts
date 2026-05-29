#!/usr/bin/env node
// Bundles helloworld client TS into build/examples/helloworld/client/.
import { cpSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outDir = resolve(root, 'build/examples/helloworld/client');
mkdirSync(outDir + '/js', { recursive: true });

// Bundle base.ts → js/base.js (CSS extracted to js/base.css)
await esbuild.build({
    entryPoints: [resolve(here, 'client/js/base.ts')],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    minify: true,
    sourcemap: false,
    outfile: resolve(outDir, 'js/base.js'),
    tsconfig: resolve(root, 'tsconfig.client.json'),
});

// Copy static assets + updated index.html
cpSync(resolve(here, 'client/assets'), resolve(outDir, 'assets'), { recursive: true });
cpSync(resolve(here, 'client/index.html'), resolve(outDir, 'index.html'));

console.log(`Helloworld client built: ${outDir}`);
