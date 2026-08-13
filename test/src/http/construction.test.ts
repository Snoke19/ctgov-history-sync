import { describe, expect, it, jest } from '@jest/globals';
import { Dispatcher, ProxyAgent } from 'undici';
import { ProxyPoolConfig } from '../../../src/config/config.js';
import { ConfigurationError } from '../../../src/error/errors.js';
import { EndpointFactory } from '../../../src/http/endpoint/endpointFactory.js';
import { EndpointManager } from '../../../src/http/endpoint/manager/endpointManager.js';
import { ProxyEndpointProvider } from '../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { DefaultLimiterFactory } from '../../../src/http/limiter/factory/defaultLimiterFactory.js';
import {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory,
} from '../../../src/http/transport/impl/undiciProxyTransport.js';
import { HttpClientOptions } from '../../../src/http/types/http.js';

/**
 * Builds an UndiciTransportFactory that never opens real sockets.
 * We inject fake creators so ProxyAgent is never instantiated with
 * real network parameters, yet the factory still behaves exactly like
 * the production one from the perspective of ProxyEndpointProvider.
 */
function createSafeTransportFactory(): UndiciTransportFactory {
    const fakePoolClientFactory = jest.fn<PoolClientFactory>().mockReturnValue({} as unknown as Dispatcher);

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

async function createManager(options: HttpClientOptions = createValidOptions()): Promise<EndpointManager> {
    const provider = new ProxyEndpointProvider(createSafeTransportFactory(), new HttpProxyUrlParser());
    const factory = new EndpointFactory(provider, new DefaultLimiterFactory());

    const endpoints = await factory.build(options);

    return new EndpointManager(endpoints, options.acquireTimeout, options.monotonicClock?.now, options.sleep);
}

describe('Proxy + Undici construction chain', () => {
    it('builds successfully with rate limiting disabled', async () => {
        const manager = await createManager(createValidOptions());

        expect(manager).toBeDefined();
        expect(manager.endpointCount).toBe(2);
    });

    it('builds successfully with rate limiting enabled', async () => {
        const manager = await createManager(
            createValidOptions({
                useRateLimit: true,
                rateLimitCapacity: 40,
                rateLimitWindow: 60000,
            }),
        );

        expect(manager).toBeDefined();
        expect(manager.endpointCount).toBe(2);
    });

    it('creates exactly one endpoint per valid proxy URL', async () => {
        const manager = await createManager(
            createValidOptions({
                proxyUrls: 'http://p1:8080,http://p2:8080,http://p3:8080',
            }),
        );

        expect(manager.endpointCount).toBe(3);
    });

    it('throws ConfigurationError when poolConfig is missing', async () => {
        const options = createValidOptions();
        delete (options as unknown as Record<string, unknown>).poolConfig;

        const result = createManager(options);

        await expect(result).rejects.toBeInstanceOf(ConfigurationError);
        await expect(result).rejects.toThrow('poolConfig');
    });

    it('throws ConfigurationError when proxyUrls is empty', async () => {
        const options = createValidOptions({ proxyUrls: '' });

        const result = createManager(options);

        await expect(result).rejects.toBeInstanceOf(ConfigurationError);
        await expect(result).rejects.toThrow('No valid proxy URLs');
    });

    it('throws ConfigurationError when every proxyUrl is invalid', async () => {
        const options = createValidOptions({
            proxyUrls: 'not-a-url,also-bad://missing-port',
        });

        await expect(createManager(options)).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('throws when acquireTimeout is missing', async () => {
        const options = createValidOptions();
        delete (options as unknown as Record<string, unknown>).acquireTimeout;

        await expect(createManager(options)).rejects.toThrow();
    });

    it('throws when concurrency is missing', async () => {
        const options = createValidOptions();
        delete (options as unknown as Record<string, unknown>).concurrency;

        await expect(createManager(options)).rejects.toThrow();
    });

    it('throws when rate limit is enabled but capacity is missing', async () => {
        const options = createValidOptions({
            useRateLimit: true,
            rateLimitWindow: 60000,
        });

        delete (options as unknown as Record<string, unknown>).rateLimitCapacity;

        await expect(createManager(options)).rejects.toThrow();
    });

    it('throws when rate limit is enabled but window is missing', async () => {
        const options = createValidOptions({
            useRateLimit: true,
            rateLimitCapacity: 40,
        });

        delete (options as unknown as Record<string, unknown>).rateLimitWindow;

        await expect(createManager(options)).rejects.toThrow();
    });

    it('produces a manager whose endpoints can be closed cleanly', async () => {
        const manager = await createManager(createValidOptions());

        await expect(manager.close()).resolves.toBeUndefined();
    });
});
