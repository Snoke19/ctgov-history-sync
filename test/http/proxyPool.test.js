import {afterAll, afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';
import {acquireProxy} from '../../src/http/proxyPool.js';

let mockTime = 0;
const REAL_NODE_ENV = process.env.NODE_ENV;

async function setupProxyPool(configOverrides = {}) {
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

describe('acquireProxy', () => {
    beforeEach(() => {
        mockTime = 0;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('ignores invalid proxies and keeps valid ones', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'invalid,https://user:pass@10.50.10.106:6254,also-invalid',
        });

        const proxy = await acquireProxy();

        expect(proxy?.url).toBe('https://user:pass@10.50.10.106:6254');
    });

    test('logs a warning for every invalid proxy', async () => {
        await setupProxyPool({
            PROXY_IPS: 'bad1,bad2,http://user:pass@10.50.10.106:6254',
        });

        const {logger} = await import('../../src/config/logging.js');

        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Skipping invalid proxy URL'),
        );
    });

    test('does not initialize proxies when NODE_ENV=test', async () => {
        jest.resetModules();

        process.env.NODE_ENV = 'test';

        jest.unstable_mockModule('../../src/config/config.js', () => ({
            ACQUIRE_TIMEOUT: 5000,
            POOL_CONNECTIONS: 10,
            RATE_LIMIT_CAPACITY: 5,
            RATE_LIMIT_WINDOW: 5000,
            PROXY_IPS: 'http://user:pass@10.50.10.106:6254',
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
            ProxyAgent: jest.fn(),
        }));

        jest.unstable_mockModule('../../src/http/poolFactory.js', () => ({
            poolFactory: jest.fn(),
        }));

        const {acquireProxy} = await import('../../src/http/proxyPool.js');

        expect(await acquireProxy()).toBeUndefined();
    });

    test('throws ProxyAcquisitionTimeoutError when waiting longer than timeout', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'http://user:pass@10.50.10.106:6254',
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 1000,
        });

        const {ProxyAcquisitionTimeoutError} = await import('../../src/error/errors.js');

        await acquireProxy();

        jest.useFakeTimers();

        const promise = acquireProxy(100);

        mockTime += 100;
        jest.advanceTimersByTime(100);

        await expect(promise).rejects.toThrow(ProxyAcquisitionTimeoutError);
        await expect(promise).rejects.toMatchObject({
            name: 'ProxyAcquisitionTimeoutError',
            timeoutMs: 100,
            proxyCount: 1,
        });
    });

    test('ProxyAcquisitionTimeoutError reports the full pool size', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'https://a:a@10.0.0.1:8000,https://b:b@10.0.0.2:8000,https://c:c@10.0.0.3:8000',
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 1_000,
        });

        await acquireProxy();
        await acquireProxy();
        await acquireProxy(); // all three now exhausted

        jest.useFakeTimers();

        const promise = acquireProxy(50);
        mockTime += 50;
        jest.advanceTimersByTime(50);

        await expect(promise).rejects.toMatchObject({proxyCount: 3});
    });

    test('uses ACQUIRE_TIMEOUT from config when timeoutMs is omitted', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'http://user:pass@10.50.10.106:6254',
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 10_000,
            ACQUIRE_TIMEOUT: 200,
        });

        await acquireProxy(); // drain the only proxy

        jest.useFakeTimers();
        const promise = acquireProxy(); // no arg

        mockTime += 200;
        jest.advanceTimersByTime(200);

        await expect(promise).rejects.toMatchObject({timeoutMs: 200});
    });

    test('skips empty entries from stray commas without throwing', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'https://a:a@10.0.0.1:8000,,   ,https://b:b@10.0.0.2:8000',
        });

        const {logger} = await import('../../src/config/logging.js');

        const first = await acquireProxy();
        expect(first.url).toBe('https://a:a@10.0.0.1:8000');
        expect(logger.warn).toHaveBeenCalledTimes(2); // the two empty entries
    });

    test('prefers the first proxy when multiple exhausted proxies become available simultaneously', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'https://a:a@10.0.0.1:8000,http://b:b@10.0.0.2:8000',
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 1000,
        });

        await acquireProxy();

        mockTime += 100;
        await acquireProxy();

        jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});

        const promise = acquireProxy();

        mockTime += 900;
        jest.advanceTimersByTime(900);

        const proxy = await promise;

        expect(proxy.url).toBe('https://a:a@10.0.0.1:8000');
    });

    test('ignores proxies with unsupported protocol', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'ftp://user:pass@10.0.0.1:21,http://user:pass@10.0.0.2:8000',
        });

        const proxy = await acquireProxy();

        expect(proxy?.url).toBe('http://user:pass@10.0.0.2:8000');
    });

    test('distributes requests across proxies using round robin', async () => {
        const proxies =
            'https://a:a@10.0.0.1:8000,' +
            'https://b:b@10.0.0.2:8000,' +
            'https://c:c@10.0.0.3:8000';

        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: proxies,
            RATE_LIMIT_CAPACITY: 5,
            RATE_LIMIT_WINDOW: 5_000,
        });

        const first = await acquireProxy();
        const second = await acquireProxy();
        const third = await acquireProxy();
        const fourth = await acquireProxy();

        expect(first.url).toBe('https://a:a@10.0.0.1:8000');
        expect(second.url).toBe('https://b:b@10.0.0.2:8000');
        expect(third.url).toBe('https://c:c@10.0.0.3:8000');
        expect(fourth.url).toBe('https://a:a@10.0.0.1:8000');
    });

    test('skips exhausted proxies and selects next available proxy', async () => {
        const proxies =
            'https://a:a@10.0.0.1:8000,' +
            'https://b:b@10.0.0.2:8000';

        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: proxies,
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 1000,
        });

        const first = await acquireProxy();
        expect(first.url).toBe('https://a:a@10.0.0.1:8000');

        const second = await acquireProxy();
        expect(second.url).toBe('https://b:b@10.0.0.2:8000');
    });

    test('returns undefined when no proxies are configured', async () => {
        const {acquireProxy} = await setupProxyPool({PROXY_IPS: ''});

        const result = await acquireProxy(2000);

        expect(result).toBeUndefined();
    });

    test('returns undefined when proxy configuration is invalid', async () => {
        const {acquireProxy} = await setupProxyPool({PROXY_IPS: 'test'});

        const result = await acquireProxy(2000);

        expect(result).toBeUndefined();
    });

    test('returns the only configured proxy', async () => {
        const {acquireProxy} = await setupProxyPool({
            PROXY_IPS: 'http://test:test@10.50.10.106:6254',
        });

        const proxy = await acquireProxy(5000);

        expect(proxy?.url).toBe('http://test:test@10.50.10.106:6254');
    });

    test('waits for a token when the only proxy is exhausted', async () => {
        const mod = await setupProxyPool({
            PROXY_IPS: 'http://test:test@10.50.10.106:6254',
            RATE_LIMIT_CAPACITY: 1,
            RATE_LIMIT_WINDOW: 1_000,
        });

        const first = await mod.acquireProxy(5000);
        expect(first?.url).toBe('http://test:test@10.50.10.106:6254');

        jest.useFakeTimers();

        const promise = mod.acquireProxy(5000);

        mockTime += 1_000;
        jest.advanceTimersByTime(1_000);

        const second = await promise;

        expect(second?.url).toBe('http://test:test@10.50.10.106:6254');
    });

    describe('when all buckets are empty', () => {
        test('waits for the proxy with the shortest timeUntil (proxy-a wins)', async () => {
            const {acquireProxy} = await setupProxyPool({
                PROXY_IPS:
                    'https://test1:test1@10.50.10.106:6254,http://test2:test2@10.50.10.106:6254',
                RATE_LIMIT_CAPACITY: 1,
                RATE_LIMIT_WINDOW: 1_000,
            });

            const first = await acquireProxy(5000);
            expect(first.url).toBe('https://test1:test1@10.50.10.106:6254');

            mockTime += 100;
            const second = await acquireProxy(5000);
            expect(second.url).toBe('http://test2:test2@10.50.10.106:6254');

            jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});

            const promise = acquireProxy(5000);

            mockTime += 900;
            jest.advanceTimersByTime(900);

            const third = await promise;
            expect(third.url).toBe('https://test1:test1@10.50.10.106:6254');
        });

        test('waits until the next available proxy when all proxies are exhausted', async () => {
            const {acquireProxy} = await setupProxyPool({
                PROXY_IPS:
                    'https://test3:test3@10.50.10.106:6254,http://test4:test4@10.50.10.106:6254',
                RATE_LIMIT_CAPACITY: 1,
                RATE_LIMIT_WINDOW: 1_000,
            });

            const first = await acquireProxy(5000);

            expect(first.url)
                .toBe('https://test3:test3@10.50.10.106:6254');

            const second = await acquireProxy(5000);

            expect(second.url)
                .toBe('http://test4:test4@10.50.10.106:6254');

            jest.useFakeTimers({doNotFake: ['nextTick', 'setImmediate']});

            const promise = acquireProxy(5000);

            mockTime += 1000;
            jest.advanceTimersByTime(1000);


            const third = await promise;

            expect(third.url).toBe('https://test3:test3@10.50.10.106:6254');
        });
    });
});
