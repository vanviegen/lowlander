// This example is Bun-only, as it conveniently transpiles client-files on the fly.
// For Node.js, you'd have to add a build step for client-files, and  serve them as
// static files (e.g. using express.static).

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as lowlander from "lowlander/server";
import index from "../client/index.html";

const apiFile = resolve(dirname(fileURLToPath(import.meta.url)), 'api.js');

// Start the WebSocket server with the given API handler
lowlander.start(apiFile, {threads: 1});

// Serve index.html on /
Bun.serve({
    port: process.env.PORT || 3000,
    routes: {
        '/': index,
    },    
    development: true,
});


// We're only doing this import here such that Bun knows to reload when api.ts changes
// when in --watch mode.
import './api';