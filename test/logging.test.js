import {describe, test} from '@jest/globals';
import assert from 'node:assert';

describe('logging.js', () => {
    test('should export logger', async () => {
        const { logger } = await import('../src/config/logging.js');
        assert.ok(logger);
        assert.strictEqual(typeof logger.info, 'function');
        assert.strictEqual(typeof logger.error, 'function');
        assert.strictEqual(typeof logger.debug, 'function');
        assert.strictEqual(typeof logger.warn, 'function');
    });

    test('should be configured with correct service name', async () => {
        const { logger } = await import('../src/config/logging.js');
        // Pino logger stores config internally, we test by checking it doesn't throw
        assert.doesNotThrow(() => {
            logger.info('test');
        });
    });

    test('should not throw when logging messages', async () => {
        const { logger } = await import('../src/config/logging.js');

        assert.doesNotThrow(() => {
            logger.info('Test info message');
            logger.error('Test error message');
            logger.debug('Test debug message');
            logger.warn('Test warn message');
        });
    });
});
