import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Dispatcher, ProxyAgent } from 'undici';
import { ProxyPoolConfig } from '../../../../../src/config/config.js';
import { CreateProxyEndpointsOptions } from '../../../../../src/http/endpoint/transport/httpTransport.js';
import type {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory as UndiciTransportFactoryType,
} from '../../../../../src/http/endpoint/transport/impl/undiciProxyTransport.js';

const mockResolveConnections = jest.fn();

jest.unstable_mockModule('../../../../../src/http/endpoint/proxy/resolveConnections.js', () => ({
    resolveConnections: mockResolveConnections,
}));

const { UndiciHttpTransport, UndiciTransportFactory } =
    await import('../../../../../src/http/endpoint/transport/impl/undiciProxyTransport.js');

const PROXY_URL = 'http://proxy.test:8080';
const RESOLVED_CONNECTIONS = 5;

function makeOptions(overrides: Partial<CreateProxyEndpointsOptions> = {}): CreateProxyEndpointsOptions {
    return {
        proxyCount: 3,
        concurrency: 10,
        poolConfig: {} as ProxyPoolConfig,
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

        factory = new UndiciTransportFactory(mockPoolCreator, mockAgentCreator);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    function getClientFactory(callIndex = 0): PoolClientFactory {
        return mockAgentCreator.mock.calls[callIndex]![1] as PoolClientFactory;
    }

    describe('create()', () => {
        describe('factory wiring', () => {
            it('resolves connections from proxyCount, concurrency, and poolConfig', () => {
                const options = makeOptions();
                factory.create(PROXY_URL, options);

                expect(mockResolveConnections).toHaveBeenCalledTimes(1);
                expect(mockResolveConnections).toHaveBeenCalledWith(
                    options.proxyCount,
                    options.concurrency,
                    options.poolConfig,
                );
            });

            it('creates a pool factory from poolConfig', () => {
                const options = makeOptions();
                factory.create(PROXY_URL, options);

                expect(mockPoolCreator).toHaveBeenCalledTimes(1);
                expect(mockPoolCreator).toHaveBeenCalledWith(options.poolConfig);
            });

            it('creates an agent from the proxy URL', () => {
                factory.create(PROXY_URL, makeOptions());

                const [uri] = mockAgentCreator.mock.calls[0]!;
                expect(uri).toBe(PROXY_URL);
            });

            it('passes a callable clientFactory to the agent creator', () => {
                factory.create(PROXY_URL, makeOptions());
                expect(getClientFactory()).toEqual(expect.any(Function));
            });

            it('returns an UndiciHttpTransport', () => {
                const result = factory.create(PROXY_URL, makeOptions());
                expect(result).toBeInstanceOf(UndiciHttpTransport);
            });
        });

        describe('clientFactory closure', () => {
            it('merges extra opts with resolved connections', () => {
                factory.create(PROXY_URL, makeOptions());
                const origin = new URL('https://target.example.com');

                getClientFactory()(origin, { keepAliveTimeout: 30_000 });

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    keepAliveTimeout: 30_000,
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('injects connections when no extra opts are supplied', () => {
                factory.create(PROXY_URL, makeOptions());
                const origin = new URL('https://target.example.com');

                getClientFactory()(origin);

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('overrides caller-supplied connections with the resolved value', () => {
                factory.create(PROXY_URL, makeOptions());
                const origin = new URL('https://target.example.com');

                getClientFactory()(origin, { connections: 9999 });

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('passes through the origin URL including path and query', () => {
                factory.create(PROXY_URL, makeOptions());
                const origin = new URL('https://target.example.com/path?query=1');

                getClientFactory()(origin);

                expect(mockPoolFactory).toHaveBeenCalledWith(origin, expect.any(Object));
            });

            it('tolerates undefined extraOpts', () => {
                factory.create(PROXY_URL, makeOptions());
                const origin = new URL('https://target.example.com');

                expect(() => getClientFactory()(origin, undefined)).not.toThrow();
            });

            it('returns the pool from poolFactory', () => {
                const mockPool = { symbol: 'dispatcher' } as unknown as Dispatcher;
                mockPoolFactory.mockReturnValue(mockPool);
                factory.create(PROXY_URL, makeOptions());

                const result = getClientFactory()(new URL('https://target.example.com'));

                expect(result).toBe(mockPool);
            });
        });

        describe('produced transport', () => {
            it('delegates close() to the agent', async () => {
                const transport = factory.create(PROXY_URL, makeOptions());
                await transport.close();

                expect(mockAgent.close).toHaveBeenCalledTimes(1);
            });
        });

        describe('state isolation', () => {
            it('isolates resolved connections between create() calls', () => {
                mockResolveConnections.mockReturnValueOnce(1).mockReturnValueOnce(99);

                factory.create('http://proxy-a:8080', makeOptions());
                const clientFactoryA = getClientFactory(0);

                factory.create('http://proxy-b:9090', makeOptions());
                const clientFactoryB = getClientFactory(1);

                clientFactoryA(new URL('https://target.com'));
                clientFactoryB(new URL('https://target.com'));

                expect(mockPoolFactory).toHaveBeenNthCalledWith(1, expect.any(URL), { connections: 1 });
                expect(mockPoolFactory).toHaveBeenNthCalledWith(2, expect.any(URL), { connections: 99 });
            });
        });

        describe('edge cases', () => {
            it('handles proxyCount and concurrency of 0', () => {
                expect(() => factory.create(PROXY_URL, makeOptions({ proxyCount: 0, concurrency: 0 }))).not.toThrow();
            });

            it('handles resolved connections of 0', () => {
                mockResolveConnections.mockReturnValue(0);
                factory.create(PROXY_URL, makeOptions());

                getClientFactory()(new URL('https://target.com'));

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(expect.any(URL), { connections: 0 });
            });

            it('preserves auth credentials in the proxy URL', () => {
                factory.create('http://user:pass@proxy.test:8080', makeOptions());
                expect(mockAgentCreator.mock.calls[0]![0]).toBe('http://user:pass@proxy.test:8080');
            });

            it('preserves a trailing slash in the proxy URL', () => {
                factory.create('http://proxy.test:8080/', makeOptions());
                expect(mockAgentCreator.mock.calls[0]![0]).toBe('http://proxy.test:8080/');
            });

            it('does not mutate the input options', () => {
                const options = makeOptions();
                factory.create(PROXY_URL, options);
                expect(options).toStrictEqual(makeOptions());
            });
        });

        describe('error handling', () => {
            it('propagates poolCreator errors', () => {
                mockPoolCreator.mockImplementation(() => {
                    throw new Error('Pool creation failed');
                });
                expect(() => factory.create(PROXY_URL, makeOptions())).toThrow('Pool creation failed');
            });

            it('propagates agentCreator errors', () => {
                mockAgentCreator.mockImplementation(() => {
                    throw new Error('Agent creation failed');
                });
                expect(() => factory.create(PROXY_URL, makeOptions())).toThrow('Agent creation failed');
            });

            it('propagates poolFactory errors through clientFactory', () => {
                mockPoolFactory.mockImplementation(() => {
                    throw new Error('Factory invocation failed');
                });
                factory.create(PROXY_URL, makeOptions());

                expect(() => getClientFactory()(new URL('https://target.com'))).toThrow('Factory invocation failed');
            });
        });
    });

    describe('constructor', () => {
        it('instantiates with production defaults', () => {
            expect(() => new UndiciTransportFactory()).not.toThrow();
        });
    });
});
