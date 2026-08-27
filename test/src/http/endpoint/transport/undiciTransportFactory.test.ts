import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Dispatcher, ProxyAgent } from 'undici';
import { ProxyPoolConfig } from '../../../../../src/config/types.js';
import { EndpointFactory } from '../../../../../src/http/endpoint/endpointFactory.js';
import { ProxyEndpointProvider } from '../../../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../../../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import { DefaultLimiterFactory } from '../../../../../src/http/limiter/factory/defaultLimiterFactory.js';
import { ProxyTransportContext } from '../../../../../src/http/transport/factory/proxyTransportFactory.js';
import type {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory as UndiciTransportFactoryType,
    UndiciTransportFactoryOptions,
} from '../../../../../src/http/transport/impl/undiciProxyTransport.js';

const mockResolveConnections = jest.fn();

jest.unstable_mockModule('../../../../../src/http/endpoint/proxy/resolveConnections.js', () => ({
    resolveConnections: mockResolveConnections,
}));

const { UndiciHttpTransport, UndiciTransportFactory } =
    await import('../../../../../src/http/transport/impl/undiciProxyTransport.js');

const PROXY_URL = 'http://proxy.test:8080';
const RESOLVED_CONNECTIONS = 5;

const POOL_CONFIG: ProxyPoolConfig = {
    connections: 10,
    maxConnections: 50,
    pipelining: 1,
    keepAliveTimeoutMs: 4000,
    headersTimeoutMs: 30000,
    bodyTimeoutMs: 30000,
    connectTimeoutMs: 5000,
};

function makeContext(overrides: Partial<ProxyTransportContext> = {}): ProxyTransportContext {
    return {
        proxyCount: 3,
        concurrency: 10,
        ...overrides,
    };
}

describe('UndiciTransportFactory', () => {
    let mockPoolFactory: jest.MockedFunction<PoolClientFactory>;
    let mockPoolCreator: jest.MockedFunction<PoolCreatorFn>;
    let mockAgentCreator: jest.MockedFunction<AgentCreatorFn>;
    let mockAgent: ProxyAgent;
    let factory: UndiciTransportFactoryType;

    beforeEach(() => {
        mockResolveConnections.mockReturnValue(RESOLVED_CONNECTIONS);

        mockPoolFactory = jest.fn<PoolClientFactory>();
        mockPoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(mockPoolFactory);

        mockAgent = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ProxyAgent;

        mockAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(mockAgent);

        factory = new UndiciTransportFactory({
            poolConfig: POOL_CONFIG,
            poolCreator: mockPoolCreator,
            agentCreator: mockAgentCreator,
        });
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    function getClientFactory(callIndex = 0): PoolClientFactory {
        return mockAgentCreator.mock.calls[callIndex]![1] as PoolClientFactory;
    }

    it('forwards pool configuration to the transport factory, not HttpClientOptions', async () => {
        const fakePoolClientFactory = jest.fn<PoolClientFactory>().mockReturnValue({} as unknown as Dispatcher);
        const fakePoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(fakePoolClientFactory);
        const fakeAgent = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ProxyAgent;
        const fakeAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(fakeAgent);

        const transportFactory = new UndiciTransportFactory({
            poolConfig: POOL_CONFIG,
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

        expect(fakePoolCreator).toHaveBeenCalledWith(POOL_CONFIG);

        await Promise.all(endpoints.map((endpoint) => endpoint.close()));
    });

    describe('create()', () => {
        describe('factory wiring', () => {
            it('resolves connections from proxyCount, concurrency, and the factory-owned poolConfig', () => {
                factory.create(PROXY_URL, makeContext());

                expect(mockResolveConnections).toHaveBeenCalledTimes(1);
                expect(mockResolveConnections).toHaveBeenCalledWith(
                    makeContext().proxyCount,
                    makeContext().concurrency,
                    POOL_CONFIG,
                );
            });

            it('creates a pool factory from the poolConfig received in its own options', () => {
                factory.create(PROXY_URL, makeContext());

                expect(mockPoolCreator).toHaveBeenCalledTimes(1);
                expect(mockPoolCreator).toHaveBeenCalledWith(POOL_CONFIG);
            });

            it('does not require the poolConfig to be passed via create()', () => {
                factory.create(PROXY_URL, makeContext());

                expect(mockResolveConnections).toHaveBeenCalledWith(
                    expect.any(Number),
                    expect.any(Number),
                    POOL_CONFIG,
                );
            });

            it('creates an agent from the proxy URL', () => {
                factory.create(PROXY_URL, makeContext());

                const [uri] = mockAgentCreator.mock.calls[0]!;
                expect(uri).toBe(PROXY_URL);
            });

            it('passes a callable clientFactory to the agent creator', () => {
                factory.create(PROXY_URL, makeContext());
                expect(getClientFactory()).toEqual(expect.any(Function));
            });

            it('returns an UndiciHttpTransport', () => {
                const result = factory.create(PROXY_URL, makeContext());
                expect(result).toBeInstanceOf(UndiciHttpTransport);
            });
        });

        describe('clientFactory closure', () => {
            it('merges extra opts with resolved connections', () => {
                factory.create(PROXY_URL, makeContext());
                const origin = new URL('https://target.example.com');

                getClientFactory()(origin, { keepAliveTimeoutMs: 30_000 });

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    keepAliveTimeoutMs: 30_000,
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('injects connections when no extra opts are supplied', () => {
                factory.create(PROXY_URL, makeContext());
                const origin = new URL('https://target.example.com');

                getClientFactory()(origin);

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('overrides caller-supplied connections with the resolved value', () => {
                factory.create(PROXY_URL, makeContext());
                const origin = new URL('https://target.example.com');

                getClientFactory()(origin, { connections: 9999 });

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('passes through the origin URL including path and query', () => {
                factory.create(PROXY_URL, makeContext());
                const origin = new URL('https://target.example.com/path?query=1');

                getClientFactory()(origin);

                expect(mockPoolFactory).toHaveBeenCalledWith(origin, expect.any(Object));
            });

            it('tolerates undefined extraOpts', () => {
                factory.create(PROXY_URL, makeContext());
                const origin = new URL('https://target.example.com');

                expect(() => getClientFactory()(origin, undefined)).not.toThrow();
            });

            it('returns the pool from poolFactory', () => {
                const mockPool = { symbol: 'dispatcher' } as unknown as Dispatcher;
                mockPoolFactory.mockReturnValue(mockPool);
                factory.create(PROXY_URL, makeContext());

                const result = getClientFactory()(new URL('https://target.example.com'));

                expect(result).toBe(mockPool);
            });
        });

        describe('produced transport', () => {
            it('delegates close() to the agent', async () => {
                const transport = factory.create(PROXY_URL, makeContext());
                await transport.close();

                expect(mockAgent.close).toHaveBeenCalledTimes(1);
            });
        });

        describe('state isolation', () => {
            it('isolates resolved connections between create() calls', () => {
                mockResolveConnections.mockReturnValueOnce(1).mockReturnValueOnce(99);

                factory.create('http://proxy-a:8080', makeContext());
                const clientFactoryA = getClientFactory(0);

                factory.create('http://proxy-b:9090', makeContext());
                const clientFactoryB = getClientFactory(1);

                clientFactoryA(new URL('https://target.com'));
                clientFactoryB(new URL('https://target.com'));

                expect(mockPoolFactory).toHaveBeenNthCalledWith(1, expect.any(URL), { connections: 1 });
                expect(mockPoolFactory).toHaveBeenNthCalledWith(2, expect.any(URL), { connections: 99 });
            });
        });

        describe('edge cases', () => {
            it('handles proxyCount and concurrency of 0', () => {
                expect(() => factory.create(PROXY_URL, makeContext({ proxyCount: 0, concurrency: 0 }))).not.toThrow();
            });

            it('handles resolved connections of 0', () => {
                mockResolveConnections.mockReturnValue(0);
                factory.create(PROXY_URL, makeContext());

                getClientFactory()(new URL('https://target.com'));

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(expect.any(URL), { connections: 0 });
            });

            it('preserves auth credentials in the proxy URL', () => {
                factory.create('http://user:pass@proxy.test:8080', makeContext());
                expect(mockAgentCreator.mock.calls[0]![0]).toBe('http://user:pass@proxy.test:8080');
            });

            it('preserves a trailing slash in the proxy URL', () => {
                factory.create('http://proxy.test:8080/', makeContext());
                expect(mockAgentCreator.mock.calls[0]![0]).toBe('http://proxy.test:8080/');
            });

            it('does not mutate the input context', () => {
                const context = makeContext();
                factory.create(PROXY_URL, context);
                expect(context).toStrictEqual(makeContext());
            });

            it('does not mutate the factory options', () => {
                const options: UndiciTransportFactoryOptions = {
                    poolConfig: POOL_CONFIG,
                    poolCreator: mockPoolCreator,
                    agentCreator: mockAgentCreator,
                };
                factory = new UndiciTransportFactory(options);
                factory.create(PROXY_URL, makeContext());
                expect(options).toStrictEqual({
                    poolConfig: POOL_CONFIG,
                    poolCreator: mockPoolCreator,
                    agentCreator: mockAgentCreator,
                });
            });
        });

        describe('error handling', () => {
            it('propagates poolCreator errors', () => {
                mockPoolCreator.mockImplementation(() => {
                    throw new Error('Pool creation failed');
                });
                expect(() => factory.create(PROXY_URL, makeContext())).toThrow('Pool creation failed');
            });

            it('propagates agentCreator errors', () => {
                mockAgentCreator.mockImplementation(() => {
                    throw new Error('Agent creation failed');
                });
                expect(() => factory.create(PROXY_URL, makeContext())).toThrow('Agent creation failed');
            });

            it('propagates poolFactory errors through clientFactory', () => {
                mockPoolFactory.mockImplementation(() => {
                    throw new Error('Factory invocation failed');
                });
                factory.create(PROXY_URL, makeContext());

                expect(() => getClientFactory()(new URL('https://target.com'))).toThrow('Factory invocation failed');
            });
        });
    });
});
