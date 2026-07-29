import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

let mockProxyIps = '';
let mockAcquireTimeout = 30000;
let currentTime = 0;

const mockLogger = {
    warn: jest.fn(),
    info: jest.fn(),
};

jest.unstable_mockModule('../../../src/config/config.js', () => ({
    get PROXY_URLS() {
        return mockProxyIps;
    },
    get ACQUIRE_TIMEOUT() {
        return mockAcquireTimeout;
    },
}));

jest.unstable_mockModule('../../../src/config/logging.js', () => ({
    logger: mockLogger,
}));

jest.unstable_mockModule('node:perf_hooks', () => ({
    performance: { now: () => currentTime },
}));

const ProxyEndpointMock = jest.fn(function ProxyEndpoint(url, limiter) {
    this.url = url;
    this.limiter = limiter;
    this.tryAcquire = jest.fn(() => true);
    this.timeUntilToken = jest.fn(() => 0);
    this.getHandle = jest.fn(() => ({ url, dispatcher: 'proxy-dispatcher' }));
});

const DirectEndpointMock = jest.fn(function DirectEndpoint(url = 'direct', limiter) {
    this.url = url;
    this.limiter = limiter;
    this.tryAcquire = jest.fn(() => true);
    this.timeUntilToken = jest.fn(() => 0);
    this.getHandle = jest.fn(() => ({ url, dispatcher: undefined }));
});

jest.unstable_mockModule('../../../src/http/endpoint/proxyEndpoint.js', () => ({
    ProxyEndpoint: ProxyEndpointMock,
}));

jest.unstable_mockModule('../../../src/http/endpoint/directEndpoint.js', () => ({
    DirectEndpoint: DirectEndpointMock,
}));

const TokenBucketMock = jest.fn(function TokenBucket(capacity, windowMs) {
    this.capacity = capacity;
    this.windowMs = windowMs;
});

const UnlimitedLimiterMock = jest.fn(function UnlimitedLimiter() {});

jest.unstable_mockModule('../../../src/http/limiter/tokenBucket.js', () => ({
    TokenBucket: TokenBucketMock,
}));

jest.unstable_mockModule('../../../src/http/limiter/unlimitedLimiter.js', () => ({
    UnlimitedLimiter: UnlimitedLimiterMock,
}));

class MockConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigurationError';
    }
}

class MockEndpointAcquisitionTimeoutError extends Error {
    constructor(timeoutMs, endpointCount) {
        super(`timed out after ${timeoutMs}ms across ${endpointCount} endpoints`);
        this.name = 'EndpointAcquisitionTimeoutError';
        this.timeoutMs = timeoutMs;
        this.endpointCount = endpointCount;
    }
}

jest.unstable_mockModule('../../../src/error/errors.js', () => ({
    ConfigurationError: MockConfigurationError,
    EndpointAcquisitionTimeoutError: MockEndpointAcquisitionTimeoutError,
}));

async function loadEndpointManager() {
    jest.resetModules();
    const { EndpointManager } = await import('../../../src/http/endpoint/endpointManager.js');
    return EndpointManager;
}

function proxyInstances() {
    return [...ProxyEndpointMock.mock.instances];
}

function directInstances() {
    return [...DirectEndpointMock.mock.instances];
}

describe('EndpointManager', () => {
    beforeEach(() => {
        mockProxyIps = '';
        mockAcquireTimeout = 30000;
        currentTime = 0;
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('Constructor & Endpoint Initialization', () => {
        test('initializes a direct endpoint when no proxies are configured', async () => {
            const EndpointManager = await loadEndpointManager();

            const manager = new EndpointManager({
                useRateLimit: false,
            });

            expect(manager).toBeInstanceOf(EndpointManager);
            expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
        });

        test('falls back to a single DirectEndpoint when useProxy is false', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: false,
                useRateLimit: true,
                rateLimitCapacity: 10,
                rateLimitWindow: 1000,
            });

            expect(ProxyEndpointMock).not.toHaveBeenCalled();
            expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
            expect(DirectEndpointMock).toHaveBeenCalledWith('direct', expect.any(TokenBucketMock));
        });

        test('falls back to a single DirectEndpoint when PROXY_URLS is empty, even if useProxy is true', async () => {
            mockProxyIps = '';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(ProxyEndpointMock).not.toHaveBeenCalled();
            expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
        });

        test('creates one ProxyEndpoint per valid, comma-separated proxy URL', async () => {
            mockProxyIps = 'http://u1:p1@1.2.3.4:8080,http://u2:p2@5.6.7.8:8081';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(ProxyEndpointMock).toHaveBeenCalledTimes(2);
            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                1,
                'http://u1:p1@1.2.3.4:8080',
                expect.any(UnlimitedLimiterMock),
            );
            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                2,
                'http://u2:p2@5.6.7.8:8081',
                expect.any(UnlimitedLimiterMock),
            );
            expect(DirectEndpointMock).not.toHaveBeenCalled();
        });

        test('trims surrounding whitespace around each proxy URL', async () => {
            mockProxyIps = '  http://u:p@1.2.3.4:80 , http://u:p@5.6.7.8:81  ';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                1,
                'http://u:p@1.2.3.4:80',
                expect.anything(),
            );
            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                2,
                'http://u:p@5.6.7.8:81',
                expect.anything(),
            );
        });

        test('skips invalid proxy URLs, logs a warning, and builds valid ones', async () => {
            mockProxyIps = 'not-a-valid-url,http://u:p@1.2.3.4:80';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(mockLogger.warn).toHaveBeenCalledWith(
                '[Proxy] Skipping invalid proxy URL: "%s"',
                'not-a-valid-url',
            );
            expect(ProxyEndpointMock).toHaveBeenCalledTimes(1);
            expect(ProxyEndpointMock).toHaveBeenCalledWith(
                'http://u:p@1.2.3.4:80',
                expect.anything(),
            );
        });

        test('falls back to DirectEndpoint when every proxy URL is invalid', async () => {
            mockProxyIps = 'garbage,also-garbage';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(mockLogger.warn).toHaveBeenCalledTimes(2);
            expect(ProxyEndpointMock).not.toHaveBeenCalled();
            expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
        });

        test('does not create a limiter for skipped or invalid proxy entries', async () => {
            mockProxyIps = 'garbage,http://u:p@1.2.3.4:80';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(UnlimitedLimiterMock).toHaveBeenCalledTimes(1);
        });

        test('logs final endpoint count once construction completes', async () => {
            mockProxyIps = 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81,http://u:p@9.9.9.9:82';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(mockLogger.info).toHaveBeenCalledWith(
                'Endpoint manager initialized | Endpoints: %d',
                3,
            );
        });

        describe('PROXY_URLS regex validation', () => {
            test.each([
                ['http://user:pass@127.0.0.1:8080', true],
                ['https://user:pass@proxy.example.com:3128', true],
                ['socks5://user:pass@1.2.3.4:1080', false],
                ['ftp://user:pass@1.2.3.4:21', false],
                ['http://1.2.3.4:8080', false],
                ['http://user:pass@1.2.3.4', false],
                ['http://user:pass@1.2.3.4:8080/', false],
                ['http://user:pass@1.2.3.4:abcd', false],
                ['', false],
            ])('%s -> valid=%s', async (url, valid) => {
                mockProxyIps = url;
                const EndpointManager = await loadEndpointManager();
                new EndpointManager({ useProxy: true, useRateLimit: false });

                if (valid) {
                    expect(ProxyEndpointMock).toHaveBeenCalledTimes(1);
                    expect(DirectEndpointMock).not.toHaveBeenCalled();
                } else {
                    expect(ProxyEndpointMock).not.toHaveBeenCalled();
                    expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
                }
            });
        });
    });

    describe('Rate Limiter Selection', () => {
        test('uses UnlimitedLimiter for every endpoint when useRateLimit is false', async () => {
            mockProxyIps = 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({ useProxy: true, useRateLimit: false });

            expect(UnlimitedLimiterMock).toHaveBeenCalledTimes(2);
            expect(TokenBucketMock).not.toHaveBeenCalled();
        });

        test('uses TokenBucket per endpoint with capacity/window when useRateLimit is true', async () => {
            mockProxyIps = 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: true,
                useRateLimit: true,
                rateLimitCapacity: 40,
                rateLimitWindow: 60000,
            });

            expect(TokenBucketMock).toHaveBeenCalledTimes(2);
            expect(TokenBucketMock).toHaveBeenNthCalledWith(1, 40, 60000);
            expect(TokenBucketMock).toHaveBeenNthCalledWith(2, 40, 60000);
            expect(UnlimitedLimiterMock).not.toHaveBeenCalled();
        });

        test('constructs a distinct limiter instance per endpoint (not shared)', async () => {
            mockProxyIps = 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81';
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: true,
                useRateLimit: true,
                rateLimitCapacity: 10,
                rateLimitWindow: 1000,
            });

            const [first, second] = TokenBucketMock.mock.instances;
            expect(first).not.toBe(second);
        });
    });

    describe('acquireEndpoint', () => {
        test('returns the handle of the first endpoint that can acquire immediately', async () => {
            mockProxyIps = 'http://u:p@1.2.3.4:80';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [endpoint] = proxyInstances();

            const handle = await manager.acquireEndpoint(1000);

            expect(handle).toEqual({
                url: 'http://u:p@1.2.3.4:80',
                dispatcher: 'proxy-dispatcher',
            });
            expect(endpoint.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('round-robins across endpoints on successive acquisition calls', async () => {
            mockProxyIps = 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80,http://u:p@3.3.3.3:80';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [e0, e1, e2] = proxyInstances();

            const h0 = await manager.acquireEndpoint(1000);
            const h1 = await manager.acquireEndpoint(1000);
            const h2 = await manager.acquireEndpoint(1000);
            const h3 = await manager.acquireEndpoint(1000);

            expect(h0.url).toBe(e0.url);
            expect(h1.url).toBe(e1.url);
            expect(h2.url).toBe(e2.url);
            expect(h3.url).toBe(e0.url);

            expect(e0.tryAcquire).toHaveBeenCalledTimes(2);
            expect(e1.tryAcquire).toHaveBeenCalledTimes(1);
            expect(e2.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('skips endpoints that cannot acquire and picks the next available one', async () => {
            mockProxyIps = 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80,http://u:p@3.3.3.3:80';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [e0, e1, e2] = proxyInstances();

            e0.tryAcquire.mockReturnValue(false);
            e1.tryAcquire.mockReturnValue(true);

            const handle = await manager.acquireEndpoint(1000);

            expect(handle.url).toBe(e1.url);
            expect(e0.tryAcquire).toHaveBeenCalledTimes(1);
            expect(e1.tryAcquire).toHaveBeenCalledTimes(1);
            expect(e2.tryAcquire).not.toHaveBeenCalled();

            e1.tryAcquire.mockReturnValue(false);
            e2.tryAcquire.mockReturnValue(true);
            const secondHandle = await manager.acquireEndpoint(1000);
            expect(secondHandle.url).toBe(e2.url);
        });

        test('waits for shortest reported timeUntilToken before retrying, then succeeds', async () => {
            jest.useFakeTimers();
            mockProxyIps = 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [e0, e1] = proxyInstances();

            e0.tryAcquire.mockReturnValueOnce(false).mockReturnValueOnce(true);
            e0.timeUntilToken.mockReturnValue(500);
            e1.tryAcquire.mockReturnValue(false);
            e1.timeUntilToken.mockReturnValue(2000);

            const acquiring = manager.acquireEndpoint(10000);

            await Promise.resolve();
            await Promise.resolve();

            currentTime = 500;
            await jest.advanceTimersByTimeAsync(500);

            const handle = await acquiring;

            expect(handle.url).toBe(e0.url);
            expect(e0.tryAcquire).toHaveBeenCalledTimes(2);
        });

        test('uses ACQUIRE_TIMEOUT from config as default timeout', async () => {
            jest.useFakeTimers();
            mockAcquireTimeout = 60;
            mockProxyIps = 'http://u:p@1.1.1.1:80';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [endpoint] = proxyInstances();

            endpoint.tryAcquire.mockReturnValue(false);
            endpoint.timeUntilToken.mockReturnValue(1000);

            const acquiring = manager.acquireEndpoint().catch((err) => err);

            await Promise.resolve();
            await Promise.resolve();

            currentTime = 60;
            await jest.advanceTimersByTimeAsync(60);

            const err = await acquiring;
            expect(err).toBeInstanceOf(MockEndpointAcquisitionTimeoutError);
            expect(err.timeoutMs).toBe(60);
        });

        test('throws EndpointAcquisitionTimeoutError once deadline passes with no endpoint available', async () => {
            jest.useFakeTimers();
            mockProxyIps = 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [e0, e1] = proxyInstances();

            e0.tryAcquire.mockReturnValue(false);
            e0.timeUntilToken.mockReturnValue(50);
            e1.tryAcquire.mockReturnValue(false);
            e1.timeUntilToken.mockReturnValue(200);

            const acquiring = manager.acquireEndpoint(100).catch((err) => err);

            await Promise.resolve();
            await Promise.resolve();

            currentTime = 100;
            await jest.advanceTimersByTimeAsync(50);

            const err = await acquiring;
            expect(err).toBeInstanceOf(MockEndpointAcquisitionTimeoutError);
            expect(err.timeoutMs).toBe(100);
            expect(err.endpointCount).toBe(2);
        });

        test('resolves immediately with DirectEndpoint fallback when it can acquire', async () => {
            mockProxyIps = '';
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({ useProxy: true, useRateLimit: false });
            const [direct] = directInstances();

            const handle = await manager.acquireEndpoint(1000);

            expect(handle).toEqual({ url: 'direct', dispatcher: undefined });
            expect(direct.tryAcquire).toHaveBeenCalledTimes(1);
        });
    });
});
