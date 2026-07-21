import {afterAll, afterEach, beforeEach, describe, expect, jest, test} from "@jest/globals";
import {acquireProxyDispatcher} from "../../src/http/proxyPool.js";

let mockTime = 0;
const REAL_NODE_ENV = process.env.NODE_ENV;

async function loadProxyPool(configOverrides = {}) {
    jest.resetModules();

    process.env.NODE_ENV = 'production';

    jest.unstable_mockModule('node:perf_hooks', () => ({
        performance: {
            now: jest.fn(() => mockTime),
        },
    }));

    jest.unstable_mockModule('../../src/config/config.js', () => ({
        ACQUIRE_TIMEOUT: 5000,
        POOL_CONNECTIONS: 10,
        RATE_LIMIT_CAPACITY: 5,
        RATE_LIMIT_WINDOW: 10_000,
        PROXY_IPS: '',
        ...configOverrides,
    }));

    jest.unstable_mockModule('../../src/config/logging.js', () => ({
        logger: {
            info: jest.fn(),
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        },
    }));

    jest.unstable_mockModule('undici', () => ({
        ProxyAgent: jest.fn().mockImplementation(({uri}) => ({uri, type: 'ProxyAgent'})),
    }));

    jest.unstable_mockModule('../../src/http/poolFactory.js', () => ({
        poolFactory: jest.fn().mockImplementation((url) => ({url, type: 'Pool'})),
    }));

    return import('../../src/http/proxyPool.js');
}

afterAll(() => {
    process.env.NODE_ENV = REAL_NODE_ENV;
});

describe("test", () => {
    beforeEach(() => {
        mockTime = 0;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should return empty object for empty input', async () => {
        const {acquireProxyDispatcher} = await loadProxyPool({raw: ''});

        const result = await acquireProxyDispatcher(2000);

        expect(result).toBeUndefined();
    });

    test('should return empty object for empty input', async () => {
        const {acquireProxyDispatcher} = await loadProxyPool({raw: 'test'});

        const result = await acquireProxyDispatcher(2000);

        expect(result).toBeUndefined();
    });

    test('should return empty object for empty input1', async () => {
        const {acquireProxyDispatcher} = await loadProxyPool({
            PROXY_IPS: 'http://test:test@10.50.10.106:6254'
        });

        const proxy = await acquireProxyDispatcher(5000);

        expect(proxy).toBeDefined();
        expect(proxy.url).toBe("http://test:test@10.50.10.106:6254");
        expect(proxy.limiter.peekTokens()).toBe(4);
    });

    test('waits when all proxies are exhausted and then acquires after refill', async () => {
        const mod = await loadProxyPool({
            PROXY_IPS: 'http://test:test@10.50.10.106:6254',
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 1_000,
        });

        const first = await mod.acquireProxyDispatcher(5000);
        expect(first).toBeDefined();
        expect(first.limiter.peekTokens()).toBe(0);

        jest.useFakeTimers();

        const promise = mod.acquireProxyDispatcher(5000);

        mockTime += 1_000;
        jest.advanceTimersByTime(1_000);

        const second = await promise;

        expect(second).toBeDefined();
        expect(second.url).toBe('http://test:test@10.50.10.106:6254');
        expect(second.limiter.peekTokens()).toBe(0);
    });

    describe('when all buckets are empty', () => {
        test('waits for the proxy with the shortest timeUntil (proxy-a wins)', async () => {
            const {acquireProxyDispatcher} = await loadProxyPool({
                PROXY_IPS: 'https://test1:test1@10.50.10.106:6254,http://test2:test2@10.50.10.106:6254',
                RATE_LIMIT_CAPACITY: 1,
                RATE_LIMIT_WINDOW: 1_000,
            });

            jest.spyOn(Math, 'random').mockReturnValue(0);
            const first = await acquireProxyDispatcher(5000);
            expect(first.url).toBe('https://test1:test1@10.50.10.106:6254');
            Math.random.mockRestore();

            mockTime += 100;
            const second = await acquireProxyDispatcher(5000);
            expect(second.url).toBe('http://test2:test2@10.50.10.106:6254');

            jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});

            const promise = acquireProxyDispatcher(5000);

            mockTime += 900;
            jest.advanceTimersByTime(900);

            const third = await promise;
            expect(third.url).toBe('https://test1:test1@10.50.10.106:6254');
            expect(third.limiter.peekTokens()).toBe(0);
        });

        test('waits for proxy-b when it has the shorter timeUntil', async () => {
            const {acquireProxyDispatcher} = await loadProxyPool({
                PROXY_IPS: 'https://test3:test3@10.50.10.106:6254,http://test4:test4@10.50.10.106:6254',
                RATE_LIMIT_CAPACITY: 1,
                RATE_LIMIT_WINDOW: 1_000,
            });

            jest.spyOn(Math, 'random').mockReturnValue(0.99);
            const first = await acquireProxyDispatcher(5000);
            expect(first.url).toBe('http://test4:test4@10.50.10.106:6254');
            Math.random.mockRestore();

            mockTime += 500;
            const second = await acquireProxyDispatcher(5000);
            expect(second.url).toBe('https://test3:test3@10.50.10.106:6254');

            jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});

            const promise = acquireProxyDispatcher(5000);

            mockTime += 500;
            jest.advanceTimersByTime(500);

            const third = await promise;
            expect(third.url).toBe('http://test4:test4@10.50.10.106:6254');
        });
    });
});
