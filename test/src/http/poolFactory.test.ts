import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProxyPoolConfig } from '../../../src/config/config.js';

interface MockPoolOptions {
    connections?: number;
    pipelining?: number;
    keepAliveTimeout?: number;
    headersTimeout?: number;
    bodyTimeout?: number;
    requestTimeout?: number;
    connect?: Record<string, unknown>;
    [key: string]: unknown;
}

const mockPoolCtor = jest.fn<(url: string | URL, options: MockPoolOptions) => void>();

jest.unstable_mockModule('undici', () => ({
    Pool: class MockPool {
        constructor(url: string | URL, options: MockPoolOptions) {
            mockPoolCtor(url, options);
        }

        async request(): Promise<unknown> {
            return { statusCode: 200, headers: {}, body: { json: async () => ({}) } };
        }

        async close(): Promise<void> {}
    },
    ProxyAgent: class MockProxyAgent {},
}));

const { createPoolFactory } = await import('../../../src/http/transport/poolFactory.js');

const POOL_CONFIG: ProxyPoolConfig = {
    connections: 2,
    maxConnections: 4,
    pipelining: 1,
    keepAliveTimeout: 300_000,
    headersTimeout: 15_000,
    bodyTimeout: 45_000,
    connectTimeout: 5_000,
};

describe('createPoolFactory', () => {
    beforeEach(() => {
        mockPoolCtor.mockClear();
    });

    it('returns a function that constructs a Pool for the given url', () => {
        const factory = createPoolFactory(POOL_CONFIG);
        factory('http://proxy.test:8080');

        expect(mockPoolCtor).toHaveBeenCalledTimes(1);
        expect(mockPoolCtor.mock.calls[0]?.[0]).toBe('http://proxy.test:8080');
    });

    it('applies pool config values by default', () => {
        createPoolFactory(POOL_CONFIG)('http://proxy.test:8080');

        const [, options] = mockPoolCtor.mock.calls[0]!;
        expect(options.connections).toBe(POOL_CONFIG.connections);
        expect(options.pipelining).toBe(POOL_CONFIG.pipelining);
        expect(options.keepAliveTimeout).toBe(POOL_CONFIG.keepAliveTimeout);
        expect(options.headersTimeout).toBe(POOL_CONFIG.headersTimeout);
        expect(options.bodyTimeout).toBe(POOL_CONFIG.bodyTimeout);
    });

    it('honors an explicit connections override', () => {
        createPoolFactory(POOL_CONFIG)('http://proxy.test:8080', { connections: 7 });

        const [, options] = mockPoolCtor.mock.calls[0]!;
        expect(options.connections).toBe(7);
    });

    it('uses the config connect timeout by default', () => {
        createPoolFactory(POOL_CONFIG)('http://proxy.test:8080');

        const [, options] = mockPoolCtor.mock.calls[0]!;
        expect(options.connect).toMatchObject({ timeout: POOL_CONFIG.connectTimeout });
    });

    it('merges an explicit connect.timeout over the config default', () => {
        createPoolFactory(POOL_CONFIG)('http://proxy.test:8080', { connect: { timeout: 900, keepAlive: true } });

        const [, options] = mockPoolCtor.mock.calls[0]!;
        expect(options.connect).toMatchObject({ timeout: 900 });
        expect(options.connect!.keepAlive).toBe(true);
    });

    it('uses the config connect timeout when connect is supplied without a timeout', () => {
        createPoolFactory(POOL_CONFIG)('http://proxy.test:8080', { connect: { keepAlive: true } });

        const [, options] = mockPoolCtor.mock.calls[0]!;
        expect(options.connect).toMatchObject({ timeout: POOL_CONFIG.connectTimeout, keepAlive: true });
    });

    it('passes through unrelated options unchanged', () => {
        createPoolFactory(POOL_CONFIG)('http://proxy.test:8080', { requestTimeout: 60_000, pipelining: 4 });

        const [, options] = mockPoolCtor.mock.calls[0]!;
        expect(options.requestTimeout).toBe(60_000);
        expect(options.pipelining).toBe(POOL_CONFIG.pipelining);
    });
});
