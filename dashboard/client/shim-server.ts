// Bare type shim so the dashboard client can compile without depending on the
// server runtime. Mirrors the public signature of dashboard/server.ts's _dashboard.
import type { ServerProxy } from 'lowlander/server';
import type { DashboardAPI } from '../server.js';
export declare function _dashboard(password: string): ServerProxy<DashboardAPI, 'authenticated'>;
