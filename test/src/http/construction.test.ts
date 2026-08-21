import { describe, expect, it, jest } from '@jest/globals';
import { Dispatcher, ProxyAgent } from 'undici';
import { ProxyPoolConfig } from '../../../src/config/config.js';
import { ConfigurationError, EndpointAssemblyError } from '../../../src/error/errors.js';
import { EndpointFactory } from '../../../src/http/endpoint/endpointFactory.js';
import { DefaultEndpointManagerFactory } from '../../../src/http/endpoint/manager/defaultEndpointManagerFactory.js';
import { EndpointManager } from '../../../src/http/endpoint/manager/endpointManager.js';
import { EndpointDefinition, EndpointProvider } from '../../../src/http/endpoint/provider/endpointProvider.js';
import { ProxyEndpointProvider } from '../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { createHttpClient } from '../../../src/http/httpClient.js';
import { DefaultLimiterFactory } from '../../../src/http/limiter/factory/defaultLimiterFactory.js';
import { LimiterFactory } from '../../../src/http/limiter/factory/limiterFactory.js';
import { HttpTransport } from '../../../src/http/transport/httpTransport.js';
import {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory,
} from '../../../src/http/transport/impl/undiciProxyTransport.js';
import { createDefaultOptions, TestClientOptions } from './httpClient/helpers.js';

const FAKE_POOL_CONFIG: ProxyPoolConfig = {
    connections: 10,
    maxConnections: 100,
    pipelining: 1,
    keepAliveTimeout: 4000,
    headersTimeout: 30000,
    bodyTimeout: 30000,
    connectTimeout: 10000,
};

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

    return new UndiciTransportFactory({
        poolConfig: FAKE_POOL_CONFIG,
        poolCreator: fakePoolCreator,
        agentCreator: fakeAgentCreator,
    });
}

const DEFAULT_PROXY_URLS = 'http://user:pass@proxy1:8080,http://proxy2:9090';

function createValidOptions(overrides: Partial<TestClientOptions> = {}): TestClientOptions {
    return {
        ...createDefaultOptions(),
        concurrency: 5,
        acquireTimeout: 30000,
        ...overrides,
    };
}

async function createManager(
    options: TestClientOptions = createValidOptions(),
    proxyUrls: string = DEFAULT_PROXY_URLS,
    limiterFactory: LimiterFactory = new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
): Promise<EndpointManager> {
    const provider = new ProxyEndpointProvider(createSafeTransportFactory(), new HttpProxyUrlParser(), {
        proxyUrls,
        concurrency: options.concurrency,
    });
    const factory = new EndpointFactory(provider, limiterFactory);

    const endpoints = await factory.build();

    return new EndpointManager(endpoints, {
        acquireTimeout: options.acquireTimeout,
        clock: options.monotonicClock?.now,
        sleep: options.sleep,
    });
}

describe('Proxy + Undici construction chain', () => {
    it('closes created endpoints when EndpointManager construction fails', async () => {
        const transport: jest.Mocked<HttpTransport> = {
            request: jest.fn(),
            classifyError: jest.fn(),
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        };

        const definition: EndpointDefinition = {
            id: 'test-endpoint',
            createTransport: () => transport,
        };

        const provider: EndpointProvider = {
            build: () => [definition],
        };

        const options = createValidOptions({
            acquireTimeout: 0,
        });

        await expect(
            createHttpClient({
                sleep: options.sleep,
                random: options.random,
                wallClock: options.wallClock,
                provider,
                limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
                endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 0 }),
            }),
        ).rejects.toBeInstanceOf(EndpointAssemblyError);

        expect(transport.close).toHaveBeenCalledTimes(1);
    });

    it('returns EndpointAssemblyError when EndpointManager construction fails and cleanup fails', async () => {
        const cleanupError = new Error('endpoint cleanup failed');

        const transport: jest.Mocked<HttpTransport> = {
            request: jest.fn(),
            classifyError: jest.fn(),
            close: jest.fn<() => Promise<void>>().mockRejectedValue(cleanupError),
        };

        const definition: EndpointDefinition = {
            id: 'test-endpoint',
            createTransport: () => transport,
        };

        const provider: EndpointProvider = {
            build: () => [definition],
        };

        const options = createValidOptions({
            acquireTimeout: 0,
        });

        await expect(
            createHttpClient({
                sleep: options.sleep,
                random: options.random,
                wallClock: options.wallClock,
                provider,
                limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
                endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 0 }),
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'EndpointAssemblyError',
                cleanupErrors: [cleanupError],
            }),
        );

        expect(transport.close).toHaveBeenCalledTimes(1);
    });

    it('rejects construction when retryConfig includes 404 in retryableStatusCodes', async () => {
        const provider: EndpointProvider = {
            build: () => [],
        };

        await expect(
            createHttpClient({
                provider,
                limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
                endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 30000 }),
                retryConfig: {
                    retryOnTimeout: true,
                    retryOnNetworkError: true,
                    retryableStatusCodes: new Set([404]),
                },
            }),
        ).rejects.toThrow('404 must not be in retryableStatusCodes');
    });

    it('rejects construction when retryConfig contains an invalid status code', async () => {
        const provider: EndpointProvider = {
            build: () => [],
        };

        await expect(
            createHttpClient({
                provider,
                limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
                endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 30000 }),
                retryConfig: {
                    retryOnTimeout: true,
                    retryOnNetworkError: true,
                    retryableStatusCodes: new Set([600]),
                },
            }),
        ).rejects.toThrow('retryableStatusCodes contains invalid status: 600');
    });

    it('rejects construction when retryConfig.baseDelayMs is not a positive integer', async () => {
        const provider: EndpointProvider = {
            build: () => [],
        };

        await expect(
            createHttpClient({
                provider,
                limiterFactory: new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
                endpointManagerFactory: new DefaultEndpointManagerFactory({ acquireTimeout: 30000 }),
                retryConfig: {
                    retryOnTimeout: true,
                    retryOnNetworkError: true,
                    retryableStatusCodes: new Set([500]),
                    baseDelayMs: 0,
                },
            }),
        ).rejects.toThrow('baseDelayMs must be a positive integer');
    });

    it('builds successfully with rate limiting disabled', async () => {
        const manager = await createManager(createValidOptions());

        expect(manager).toBeDefined();
        expect(manager.endpointCount).toBe(2);
    });

    it('builds successfully with rate limiting enabled', async () => {
        const manager = await createManager(
            createValidOptions(),
            DEFAULT_PROXY_URLS,
            new DefaultLimiterFactory({
                enabled: true,
                capacity: 40,
                windowMs: 60000,
            }),
        );

        expect(manager).toBeDefined();
        expect(manager.endpointCount).toBe(2);
    });

    it('creates exactly one endpoint per valid proxy URL', async () => {
        const manager = await createManager(createValidOptions(), 'http://p1:8080,http://p2:8080,http://p3:8080');

        expect(manager.endpointCount).toBe(3);
    });

    it('forwards pool configuration to the transport factory, not HttpClientOptions', async () => {
        const fakePoolClientFactory = jest.fn<PoolClientFactory>().mockReturnValue({} as unknown as Dispatcher);
        const fakePoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(fakePoolClientFactory);
        const fakeAgent = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ProxyAgent;
        const fakeAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(fakeAgent);

        const transportFactory = new UndiciTransportFactory({
            poolConfig: FAKE_POOL_CONFIG,
            poolCreator: fakePoolCreator,
            agentCreator: fakeAgentCreator,
        });

        const provider = new ProxyEndpointProvider(transportFactory, new HttpProxyUrlParser(), {
            proxyUrls: 'http://proxy:8080',
            concurrency: 5,
        });
        const factory = new EndpointFactory(
            provider,
            new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
        );

        const endpoints = await factory.build();

        expect(fakePoolCreator).toHaveBeenCalledWith(FAKE_POOL_CONFIG);

        await Promise.all(endpoints.map((endpoint) => endpoint.close()));
    });

    it('throws ConfigurationError when proxyUrls is empty', async () => {
        const result = createManager(createValidOptions(), '');

        await expect(result).rejects.toBeInstanceOf(ConfigurationError);
        await expect(result).rejects.toThrow('No valid proxy URLs');
    });

    it('throws ConfigurationError when every proxyUrl is invalid', async () => {
        await expect(createManager(createValidOptions(), 'not-a-url,also-bad://missing-port')).rejects.toBeInstanceOf(
            ConfigurationError,
        );
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

    it('produces a manager whose endpoints can be closed cleanly', async () => {
        const manager = await createManager(createValidOptions());

        await expect(manager.close()).resolves.toBeUndefined();
    });
});
