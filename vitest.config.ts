import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        conditions: ['bun', 'browser', 'module', 'import', 'default'],
        alias: {
            // Route aberdeen/test-helpers to its TS source so fakedom is a
            // proper ESM import (evaluated before aberdeen), fixing the
            // initialization-order bug in the compiled helpers.js bundle.
            'aberdeen/test-helpers': resolve('../aberdeen/tests/helpers.ts'),
            'bun:test': 'vitest',
        },
    },
    test: {
        // *.spec.ts under tests/ are ShoTest (Playwright) browser tests, run via
        // `npm run test:e2e`; vitest only owns the *.test.ts unit/integration tests.
        include: ['**/*.test.ts'],
        environment: 'node',
        pool: 'forks',
        singleFork: true,
        sequence: { concurrent: false },
        // Pre-load fakedom before any test file so `document` exists when
        // aberdeen initialises its ROOT_SCOPE.  The bun condition above
        // routes aberdeen/test-helpers → helpers.ts, which also imports
        // ./fakedom — it will hit the same module-cache entry as this
        // setupFile, giving everyone the same document object.
        setupFiles: ['../aberdeen/tests/fakedom.ts'],
    },
});
