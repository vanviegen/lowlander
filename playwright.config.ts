import { defineConfig } from 'shotest';

// Port the dashboard test-server listens on (kept off common dev ports).
const PORT = 3199;

export default defineConfig({
    testDir: 'tests',
    // vitest owns *.test.ts in tests/; shotest browser specs are *.spec.ts.
    testMatch: '**/*.spec.ts',
    // ShoTest captures a screenshot per step, so browser tests need extra headroom.
    timeout: 60_000,
    workers: 1, // the dashboard talks to a single stateful server
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1100, height: 850 },
        screenshot: 'off', // ShoTest captures its own annotated screenshots
    },
    webServer: {
        // Rebuild the dashboard bundle so the served HTML reflects the current
        // client source, then start the helloworld example server (which serves
        // the dashboard at /_dashboard and the WebSocket API on the same port).
        command: 'bun dashboard/build-bundle.ts && bun examples/helloworld/server/main.ts',
        port: PORT,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
        env: {
            PORT: String(PORT),
            LOWLANDER_DASHBOARD_PASSWORD: 'test-secret-pw',
        },
    },
});
