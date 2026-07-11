import {describe, test} from 'node:test';
import assert from 'node:assert';

describe('index.js', () => {
    test('should import and execute without errors', async () => {
        // Mock global fetch to prevent actual API calls
        const originalFetch = globalThis.fetch;
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ history: { changes: [] } }),
        });

        // Mock logger to prevent actual logging
        const originalLogger = (await import('../src/logging.js')).logger;

        try {
            // Import index.js which executes the main code
            await import('../src/index.js');
            assert.ok(true, 'Index module loaded successfully');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
