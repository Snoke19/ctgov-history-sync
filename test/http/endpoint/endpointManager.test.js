import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

let currentTime = 0;

const mockLogger = {
    warn: jest.fn(),
    info: jest.fn(),
};

jest.unstable_mockModule('../../../src/config/logging.js', () => ({
    logger: mockLogger,
}));

jest.unstable_mockModule('node:perf_hooks', () => ({
    performance: {now: () => currentTime},
}));

const ProxyEndpointMock = jest.fn(function ProxyEndpoint(url, limiter) {
    this.url = url;
    this.limiter = limiter;
    this.tryAcquire = jest.fn(() => true);
    this.timeUntilToken = jest.fn(() => 0);
    this.getHandle = jest.fn(() => ({url, dispatcher: 'proxy-dispatcher'}));
});

const DirectEndpointMock = jest.fn(function DirectEndpoint(url = 'direct', limiter) {
    this.url = url;
    this.limiter = limiter;
    this.tryAcquire = jest.fn(() => true);
    this.timeUntilToken = jest.fn(() => 0);
    this.getHandle = jest.fn(() => ({url, dispatcher: undefined}));
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

const UnlimitedLimiterMock = jest.fn(function UnlimitedLimiter() {
});

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
    const {EndpointManager} = await import('../../../src/http/endpoint/endpointManager.js');
    return EndpointManager;
}

function proxyInstances() {
    return [...ProxyEndpointMock.mock.instances];
}

function directInstances() {
    return [...DirectEndpointMock.mock.instances];
}

const samplePoolConfig = Object.freeze({
    connections: 10,
    maxConnections: 50,
    pipelining: 1,
    keepAliveTimeout: 4_000,
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
    connectTimeout: 5_000,
});

describe('EndpointManager', () => {
    beforeEach(() => {
        currentTime = 0;
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('Constructor & Endpoint Initialization', () => {
        test('initializes a direct endpoint when proxy mode is disabled', async () => {
            const EndpointManager = await loadEndpointManager();

            const manager = new EndpointManager({
                useProxy: false,
                useRateLimit: false,
                rateLimitCapacity: 10,
                rateLimitWindow: 1000,
                acquireTimeout: 1000,
            });

            expect(manager).toBeInstanceOf(EndpointManager);
            expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
            expect(ProxyEndpointMock).not.toHaveBeenCalled();
        });

        test('throws when proxy mode is enabled but no proxy URLs are configured', async () => {
            const EndpointManager = await loadEndpointManager();

            expect(() => {
                new EndpointManager({
                    useProxy: true,
                    proxyUrls: '',
                    useRateLimit: false,
                    acquireTimeout: 1000,
                    poolConfig: samplePoolConfig,
                });
            }).toThrow(MockConfigurationError);

            expect(DirectEndpointMock).not.toHaveBeenCalled();
            expect(ProxyEndpointMock).not.toHaveBeenCalled();
        });

        test('falls back to a single DirectEndpoint when useProxy is false', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: false,
                useRateLimit: true,
                rateLimitCapacity: 10,
                rateLimitWindow: 1000,
                acquireTimeout: 1000
            });

            expect(ProxyEndpointMock).not.toHaveBeenCalled();
            expect(DirectEndpointMock).toHaveBeenCalledTimes(1);
            expect(DirectEndpointMock).toHaveBeenCalledWith('direct', expect.any(TokenBucketMock));
        });

        test('throws when useProxy is enabled but proxyUrls is empty', async () => {
            const EndpointManager = await loadEndpointManager();

            expect(() => {
                new EndpointManager({
                    useProxy: true,
                    proxyUrls: '',
                    useRateLimit: false,
                    acquireTimeout: 1000,
                    poolConfig: samplePoolConfig,
                });
            }).toThrow(MockConfigurationError);

            expect(ProxyEndpointMock).not.toHaveBeenCalled();
            expect(DirectEndpointMock).not.toHaveBeenCalled();
        });

        test('throws when useProxy is enabled but poolConfig is not provided', async () => {
            const EndpointManager = await loadEndpointManager();

            expect(() => {
                new EndpointManager({
                    useProxy: true,
                    proxyUrls: 'http://u:p@1.2.3.4:80',
                    useRateLimit: false,
                    acquireTimeout: 1000,
                });
            }).toThrow(MockConfigurationError);

            expect(ProxyEndpointMock).not.toHaveBeenCalled();
        });

        test('creates one ProxyEndpoint per valid, comma-separated proxy URL', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                proxyUrls: 'http://u1:p1@1.2.3.4:8080,http://u2:p2@5.6.7.8:8081',
                useProxy: true,
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(ProxyEndpointMock).toHaveBeenCalledTimes(2);
            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                1,
                'http://u1:p1@1.2.3.4:8080',
                expect.any(UnlimitedLimiterMock),
                expect.objectContaining({poolConfig: samplePoolConfig}),
            );
            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                2,
                'http://u2:p2@5.6.7.8:8081',
                expect.any(UnlimitedLimiterMock),
                expect.objectContaining({poolConfig: samplePoolConfig}),
            );
            expect(DirectEndpointMock).not.toHaveBeenCalled();
        });

        test('trims surrounding whitespace around each proxy URL', async () => {
            const EndpointManager = await loadEndpointManager();

            new EndpointManager({
                useProxy: true,
                proxyUrls: '  http://u:p@1.2.3.4:80 , http://u:p@5.6.7.8:81  ',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                1, 'http://u:p@1.2.3.4:80', expect.any(UnlimitedLimiterMock),
                expect.objectContaining({poolConfig: samplePoolConfig}),
            );

            expect(ProxyEndpointMock).toHaveBeenNthCalledWith(
                2, 'http://u:p@5.6.7.8:81', expect.any(UnlimitedLimiterMock),
                expect.objectContaining({poolConfig: samplePoolConfig}),
            );

            expect(DirectEndpointMock).not.toHaveBeenCalled();
        });

        test('skips invalid proxy URLs, logs a warning, and builds valid ones', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: true,
                proxyUrls: 'not-a-valid-url,http://u:p@1.2.3.4:80',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(mockLogger.warn).toHaveBeenCalledWith(
                '[Proxy] Skipping invalid proxy URL: "%s"',
                'not-a-valid-url',
            );
            expect(ProxyEndpointMock).toHaveBeenCalledTimes(1);
            expect(ProxyEndpointMock).toHaveBeenCalledWith(
                'http://u:p@1.2.3.4:80',
                expect.anything(),
                expect.objectContaining({poolConfig: samplePoolConfig}),
            );
        });

        test('throws when every proxy URL is invalid', async () => {
            const EndpointManager = await loadEndpointManager();

            expect(() => {
                new EndpointManager({
                    useProxy: true,
                    proxyUrls: 'garbage,also-garbage',
                    useRateLimit: false,
                    acquireTimeout: 1000,
                    poolConfig: samplePoolConfig,
                });
            }).toThrow(MockConfigurationError);

            expect(mockLogger.warn).toHaveBeenCalledTimes(2);

            expect(mockLogger.warn).toHaveBeenNthCalledWith(
                1, '[Proxy] Skipping invalid proxy URL: "%s"', 'garbage',
            );

            expect(mockLogger.warn).toHaveBeenNthCalledWith(
                2, '[Proxy] Skipping invalid proxy URL: "%s"', 'also-garbage',
            );

            expect(ProxyEndpointMock).not.toHaveBeenCalled();
            expect(DirectEndpointMock).not.toHaveBeenCalled();
        });

        test('does not create a limiter for skipped or invalid proxy entries', async () => {
            const EndpointManager = await loadEndpointManager();

            new EndpointManager({
                useProxy: true,
                proxyUrls: 'garbage,http://u:p@1.2.3.4:80',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(mockLogger.warn).toHaveBeenCalledWith(
                '[Proxy] Skipping invalid proxy URL: "%s"', 'garbage',
            );

            expect(ProxyEndpointMock).toHaveBeenCalledTimes(1);
            expect(UnlimitedLimiterMock).toHaveBeenCalledTimes(1);
        });

        test('logs final endpoint count once construction completes', async () => {
            const EndpointManager = await loadEndpointManager();

            new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81,http://u:p@9.9.9.9:82',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(mockLogger.info).toHaveBeenCalledWith(
                'Endpoint manager initialized | Endpoints: %d',
                3,
            );
        });

        describe('PROXY_URLS validation (URL-based)', () => {
            test.each([
                ['http://user:pass@127.0.0.1:8080'],
                ['https://user:pass@proxy.example.com:3128'],
                ['http://1.2.3.4:8080'],                        // no-auth (IP-whitelisted) proxy — now allowed
                ['http://user:pass@proxy.example.com:80'],       // explicit default HTTP port — regression test for the port bug
                ['https://user:pass@proxy.example.com:443'],     // explicit default HTTPS port — same bug, other scheme
                ['http://user:pass@1.2.3.4:8080/'],              // trailing slash — URL parser normalizes pathname, no longer rejected
                ['http://[::1]:8080'],                           // IPv6 host, no auth
            ])('accepts %s', async (proxyUrls) => {
                const EndpointManager = await loadEndpointManager();

                new EndpointManager({
                    useProxy: true,
                    proxyUrls,
                    useRateLimit: false,
                    acquireTimeout: 1000,
                    poolConfig: samplePoolConfig,
                });

                expect(ProxyEndpointMock).toHaveBeenCalledTimes(1);
                expect(DirectEndpointMock).not.toHaveBeenCalled();
            });

            test.each([
                'socks5://user:pass@1.2.3.4:1080',   // wrong protocol
                'ftp://user:pass@1.2.3.4:21',        // wrong protocol
                'http://user:pass@1.2.3.4',          // missing explicit port
                'http://user:pass@1.2.3.4:abcd',     // non-numeric port — URL constructor throws
                'not-a-valid-url',                   // unparseable
            ])('rejects invalid proxy URL %s', async (proxyUrls) => {
                const EndpointManager = await loadEndpointManager();

                expect(() => {
                    new EndpointManager({
                        useProxy: true,
                        proxyUrls,
                        useRateLimit: false,
                        acquireTimeout: 1000,
                        poolConfig: samplePoolConfig,
                    });
                }).toThrow(
                    'useProxy is enabled, but no valid proxy URLs were configured.',
                );
            });

            test('rejects empty proxyUrls', async () => {
                const EndpointManager = await loadEndpointManager();

                expect(() => {
                    new EndpointManager({
                        useProxy: true,
                        proxyUrls: '',
                        useRateLimit: false,
                        acquireTimeout: 1000,
                        poolConfig: samplePoolConfig,
                    });
                }).toThrow(
                    'proxyUrls must be a non-empty string when useProxy is enabled.',
                );
            });
        });
    });

    describe('Rate Limiter Selection', () => {
        test('uses UnlimitedLimiter for every endpoint when useRateLimit is false', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(UnlimitedLimiterMock).toHaveBeenCalledTimes(2);
            expect(TokenBucketMock).not.toHaveBeenCalled();
        });

        test('uses TokenBucket per endpoint with capacity/window when useRateLimit is true', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81',
                useRateLimit: true,
                rateLimitCapacity: 40,
                rateLimitWindow: 60000,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            expect(TokenBucketMock).toHaveBeenCalledTimes(2);
            expect(TokenBucketMock).toHaveBeenNthCalledWith(1, 40, 60000);
            expect(TokenBucketMock).toHaveBeenNthCalledWith(2, 40, 60000);
            expect(UnlimitedLimiterMock).not.toHaveBeenCalled();
        });

        test('constructs a distinct limiter instance per endpoint (not shared)', async () => {
            const EndpointManager = await loadEndpointManager();
            new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81',
                useRateLimit: true,
                rateLimitCapacity: 10,
                rateLimitWindow: 1000,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            const [first, second] = TokenBucketMock.mock.instances;
            expect(first).not.toBe(second);
        });
    });

    describe('acquireEndpoint', () => {
        test('returns the handle of the first endpoint that can acquire immediately', async () => {
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.2.3.4:80,http://u:p@5.6.7.8:81',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });
            const [endpoint] = proxyInstances();

            const handle = await manager.acquireEndpoint(1000);

            expect(handle).toEqual({
                url: 'http://u:p@1.2.3.4:80',
                dispatcher: 'proxy-dispatcher',
            });
            expect(endpoint.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('round-robins across endpoints on successive acquisition calls', async () => {
            const EndpointManager = await loadEndpointManager();

            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80,http://u:p@3.3.3.3:80',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });

            const [e0, e1, e2] = proxyInstances();

            const h0 = await manager.acquireEndpoint();
            const h1 = await manager.acquireEndpoint();
            const h2 = await manager.acquireEndpoint();
            const h3 = await manager.acquireEndpoint();

            expect(h0.url).toBe(e0.url);
            expect(h1.url).toBe(e1.url);
            expect(h2.url).toBe(e2.url);
            expect(h3.url).toBe(e0.url);

            expect(e0.tryAcquire).toHaveBeenCalledTimes(2);
            expect(e1.tryAcquire).toHaveBeenCalledTimes(1);
            expect(e2.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('skips endpoints that cannot acquire and picks the next available one', async () => {
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80,http://u:p@3.3.3.3:80',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });
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
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80',
                useRateLimit: false,
                acquireTimeout: 1000,
                poolConfig: samplePoolConfig,
            });
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

            const EndpointManager = await loadEndpointManager();

            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80',
                useRateLimit: false,
                acquireTimeout: 60,
                poolConfig: samplePoolConfig,
            });

            const [e0, e1] = proxyInstances();

            e0.tryAcquire.mockReturnValue(false);
            e0.timeUntilToken.mockReturnValue(1000);

            e1.tryAcquire.mockReturnValue(false);
            e1.timeUntilToken.mockReturnValue(1000);

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
            const EndpointManager = await loadEndpointManager();
            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80',
                useRateLimit: false,
                acquireTimeout: 60,
                poolConfig: samplePoolConfig,
            });
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

        test('resolves immediately with first proxy endpoint when it can acquire', async () => {
            const EndpointManager = await loadEndpointManager();

            const manager = new EndpointManager({
                useProxy: true,
                proxyUrls: 'http://u:p@1.1.1.1:80,http://u:p@2.2.2.2:80',
                useRateLimit: false,
                acquireTimeout: 60,
                poolConfig: samplePoolConfig,
            });

            const [proxy] = proxyInstances();

            const handle = await manager.acquireEndpoint(1000);

            expect(handle).toEqual({
                url: proxy.url,
                dispatcher: 'proxy-dispatcher',
            });

            expect(proxy.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('resolves immediately with DirectEndpoint when proxy mode is disabled', async () => {
            const EndpointManager = await loadEndpointManager();

            const manager = new EndpointManager({
                useProxy: false,
                useRateLimit: false,
                acquireTimeout: 60,
            });

            const [direct] = directInstances();

            const handle = await manager.acquireEndpoint(1000);

            expect(handle).toEqual({
                url: 'direct',
                dispatcher: undefined,
            });

            expect(direct.tryAcquire).toHaveBeenCalledTimes(1);
        });
    });
});
