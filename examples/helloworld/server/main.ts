// Starts the Lowlander WebSocket (+ HTTP) server.
// warpsocket serves HTTP at the same port as WebSocket; the API module
// exports handleHttpRequest to serve the client bundle and the dashboard.

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import * as lowlander from "lowlander/server";

const apiFile = resolve(dirname(fileURLToPath(import.meta.url)), 'api.js');

lowlander.start(apiFile, { bind: `0.0.0.0:${process.env.PORT || 8080}` });
