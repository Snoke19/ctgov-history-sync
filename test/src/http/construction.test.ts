import { describe, expect, it, jest } from '@jest/globals';
import { ProxyPoolConfig } from '../../../src/config/config.js';
import { EndpointFactory } from '../../../src/http/endpoint/endpointFactory.js';
import { EndpointManagerFactory } from '../../../src/http/endpoint/manager/endpointManagerFactory.js';
import { ProxyEndpointProvider } from '../../../src/http/endpoint/provider/proxyEndpointProvider.js';
import { DefaultLimiterFactory } from '../../../src/http/limiter/factory/defaultLimiterFactory.js';
import { HttpClientOptions } from '../../../src/http/types/http.js';
import { ConfigurationError } from '../../../src/error/errors.js';
import { Dispatcher, ProxyAgent } from 'undici';
import {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory,
} from '../../../src/http/endpoint/transport/impl/undiciProxyTransport.js';
import { HttpProxyUrlParser } from '../../../src/http/endpoint/proxy/httpProxyUrlParser.js';

/**
 * Builds an UndiciTransportFactory that never opens real sockets.
 * We inject fake creators so ProxyAgent is never instantiated with
 * real network parameters, yet the factory still behaves exactly like
 * the production one from the perspective of ProxyEndpointProvider.
 */
function createSafeTransportFactory(): UndiciTransportFactory {
    const fakePoolClientFactory = jest
        .fn<PoolClientFactory>()
        .mockReturnValue({} as unknown as Dispatcher);

    const fakePoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(fakePoolClientFactory);
    const fakeAgent = {
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as ProxyAgent;
    const fakeAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(fakeAgent);

    return new UndiciTransportFactory(fakePoolCreator, fakeAgentCreator);
}

function createValidOptions(overrides: Partial<HttpClientOptions> = {}): HttpClientOptions {
    const poolConfig: ProxyPoolConfig = {
        connections: 10,
        maxConnections: 100,
        pipelining: 1,
        keepAliveTimeout: 4000,
        headersTimeout: 30000,
        bodyTimeout: 30000,
        connectTimeout: 10000,
    };

    return {
        proxyUrls: 'http://user:pass@proxy1:8080,http://proxy2:9090',
        poolConfig,
        concurrency: 5,
        acquireTimeout: 30000,
        useRateLimit: false,
        ...overrides,
    } as HttpClientOptions;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Proxy + Undici construction chain', () => {
    it('builds successfully with rate limiting disabled', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const manager = new EndpointManagerFactory(factory).create(createValidOptions());

        expect(manager).toBeDefined();
        expect(manager.endpointCount).toBe(2); // one endpoint per proxy URL
    });

    it('builds successfully with rate limiting enabled', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const manager = new EndpointManagerFactory(factory).create(
            createValidOptions({
                useRateLimit: true,
                rateLimitCapacity: 40,
                rateLimitWindow: 60000,
            }),
        );

        expect(manager).toBeDefined();
        expect(manager.endpointCount).toBe(2);
    });

    it('creates exactly one endpoint per valid proxy URL', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const manager = new EndpointManagerFactory(factory).create(
            createValidOptions({
                proxyUrls: 'http://p1:8080,http://p2:8080,http://p3:8080',
            }),
        );

        expect(manager.endpointCount).toBe(3);
    });

    // ─── ProxyEndpointProvider validation ───────────────────────────────────

    it('throws ConfigurationError when poolConfig is missing', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions();
        delete (options as any).poolConfig;

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow(
            ConfigurationError,
        );
        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow('poolConfig');
    });

    it('throws ConfigurationError when proxyUrls is empty', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions({ proxyUrls: '' });

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow(
            ConfigurationError,
        );
        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow(
            'No valid proxy URLs',
        );
    });

    it('throws ConfigurationError when every proxyUrl is invalid', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions({ proxyUrls: 'not-a-url,also-bad://missing-port' });

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow(
            ConfigurationError,
        );
    });

    // ─── EndpointManagerFactory validation ──────────────────────────────────

    it('throws when acquireTimeout is missing', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions();
        delete (options as any).acquireTimeout;

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow();
    });

    it('throws when concurrency is missing', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions();
        delete (options as any).concurrency;

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow();
    });

    // ─── DefaultLimiterFactory validation ───────────────────────────────────

    it('throws when rate limit is enabled but capacity is missing', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions({
            useRateLimit: true,
            rateLimitWindow: 60000,
        });
        delete (options as any).rateLimitCapacity;

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow();
    });

    it('throws when rate limit is enabled but window is missing', () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const options = createValidOptions({
            useRateLimit: true,
            rateLimitCapacity: 40,
        });
        delete (options as any).rateLimitWindow;

        expect(() => new EndpointManagerFactory(factory).create(options)).toThrow();
    });

    // ─── Lifecycle smoke test ───────────────────────────────────────────────

    it('produces a manager whose endpoints can be closed cleanly', async () => {
        const provider = new ProxyEndpointProvider(
            createSafeTransportFactory(),
            new HttpProxyUrlParser(),
        );
        const factory = new EndpointFactory(provider, new DefaultLimiterFactory());
        const manager = new EndpointManagerFactory(factory).create(createValidOptions());

        // If transports were not wired correctly, this would throw
        await expect(manager.close()).resolves.toBeUndefined();
    });
});
