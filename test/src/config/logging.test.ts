import { describe, expect, it, jest } from '@jest/globals';
import { logger } from '../../../src/config/logging.js';

describe('logger', () => {
    it('exports a pino logger with the standard level methods', () => {
        expect(logger).toBeDefined();

        for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
            expect(typeof logger[method]).toBe('function');
        }
    });

    it('honours LOG_LEVEL from the environment at construction time', () => {
        // Both sides read the same process.env, so this checks the module
        // contract (level reflects LOG_LEVEL when present) without asserting
        // a hard-coded value that would break when .env.test changes.
        if (process.env.LOG_LEVEL !== undefined) {
            expect(logger.level).toBe(process.env.LOG_LEVEL);
        } else {
            const expected = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
            expect(logger.level).toBe(expected);
        }
    });

    it('accepts printf-style and object log calls without throwing', () => {
        expect(() => logger.info('hello %s', 'world')).not.toThrow();
        expect(() => logger.warn({ context: 'test' }, 'with fields')).not.toThrow();
        expect(() => logger.error(new Error('expected test error'))).not.toThrow();
        expect(() => logger.debug('suppressed at info level, but must not throw')).not.toThrow();
    });
});

describe('logger (production mode)', () => {
    it('defaults to info level when NODE_ENV=production and LOG_LEVEL is unset', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const hadLogLevel = Object.prototype.hasOwnProperty.call(process.env, 'LOG_LEVEL');
        const originalLogLevel = process.env.LOG_LEVEL;

        try {
            process.env.NODE_ENV = 'production';
            delete process.env.LOG_LEVEL;

            // Fresh module instance so the top-level config is re-evaluated.
            jest.resetModules();
            const { logger: productionLogger } = await import('../../../src/config/logging.js');

            expect(productionLogger.level).toBe('info');
            expect(typeof productionLogger.error).toBe('function');
            expect(() => productionLogger.error(new Error('prod'))).not.toThrow();
        } finally {
            // Environment is snapshotted before any await and restored after
            // the async re-import; the rule cannot prove that here.
            // eslint-disable-next-line require-atomic-updates -- env snapshot restore
            process.env.NODE_ENV = originalNodeEnv;
            if (hadLogLevel) {
                // eslint-disable-next-line require-atomic-updates -- env snapshot restore
                process.env.LOG_LEVEL = originalLogLevel;
            } else {
                delete process.env.LOG_LEVEL;
            }
            jest.resetModules();
            await import('../../../src/config/logging.js');
        }
    });
});
