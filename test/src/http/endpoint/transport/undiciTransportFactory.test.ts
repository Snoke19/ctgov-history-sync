import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProxyPoolConfig } from '../../../../../src/config/config.js';
import { CreateProxyEndpointsOptions } from '../../../../../src/http/endpoint/transport/httpTransport.js';

import type {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory as UndiciTransportFactoryType,
} from '../../../../../src/http/endpoint/transport/impl/undiciProxyTransport.js';
import { Dispatcher, ProxyAgent } from 'undici';

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
    let options: CreateProxyEndpointsOptions;

    beforeEach(() => {
        mockResolveConnections.mockReturnValue(RESOLVED_CONNECTIONS);

        mockPoolFactory = jest.fn<PoolClientFactory>();

        mockPoolCreator = jest.fn<PoolCreatorFn>().mockReturnValue(mockPoolFactory);

        mockAgent = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ProxyAgent;

        mockAgentCreator = jest.fn<AgentCreatorFn>().mockReturnValue(mockAgent);

        factory = new UndiciTransportFactory(mockPoolCreator, mockAgentCreator);

        options = makeOptions();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('create()', () => {
        it('handles resolveConnections returning 0 without crashing', () => {
            mockResolveConnections.mockReturnValue(0);
            const result = factory.create(PROXY_URL, options);
            expect(result).toBeInstanceOf(UndiciHttpTransport);

            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;
            clientFactory(new URL('https://target.com'));
            expect(mockPoolFactory).toHaveBeenCalledWith(expect.any(URL), { connections: 0 });
        });

        it('handles proxyCount and concurrency of 0', () => {
            options = makeOptions({ proxyCount: 0, concurrency: 0 });
            expect(() => factory.create(PROXY_URL, options)).not.toThrow();
        });

        it('passes proxy URL with auth credentials unchanged', () => {
            const proxyWithAuth = 'http://user:pass@proxy.test:8080';
            factory.create(proxyWithAuth, options);
            const [uri] = mockAgentCreator.mock.calls[0]!;
            expect(uri).toBe(proxyWithAuth);
        });

        it('passes proxy URL with trailing slash unchanged', () => {
            const proxyWithSlash = 'http://proxy.test:8080/';
            factory.create(proxyWithSlash, options);
            const [uri] = mockAgentCreator.mock.calls[0]!;
            expect(uri).toBe(proxyWithSlash);
        });

        it('passes origin URL object through to poolFactory including path and query', () => {
            factory.create(PROXY_URL, options);
            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;

            const origin = new URL('https://target.example.com/path?query=1');
            clientFactory(origin);

            // Pool should still receive the origin object as-is
            expect(mockPoolFactory).toHaveBeenCalledWith(origin, expect.any(Object));
        });

        it('handles undefined extraOpts gracefully', () => {
            factory.create(PROXY_URL, options);
            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;

            const origin = new URL('https://target.example.com');
            expect(() => clientFactory(origin, undefined)).not.toThrow();
        });

        it('merges multiple extra options without losing resolved connections', () => {
            factory.create(PROXY_URL, options);
            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;

            const origin = new URL('https://target.example.com');
            clientFactory(origin, {
                keepAliveTimeout: 30_000,
                bodyTimeout: 10_000,
                connections: 999,
            });

            expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                keepAliveTimeout: 30_000,
                bodyTimeout: 10_000,
                connections: RESOLVED_CONNECTIONS, // still wins
            });
        });

        it('propagates errors from poolCreator', () => {
            mockPoolCreator.mockImplementation(() => {
                throw new Error('Pool creation failed');
            });
            expect(() => factory.create(PROXY_URL, options)).toThrow('Pool creation failed');
        });

        it('propagates errors from agentCreator', () => {
            mockAgentCreator.mockImplementation(() => {
                throw new Error('Agent creation failed');
            });
            expect(() => factory.create(PROXY_URL, options)).toThrow('Agent creation failed');
        });

        it('propagates errors from poolFactory through clientFactory', () => {
            mockPoolFactory.mockImplementation(() => {
                throw new Error('Factory invocation failed');
            });
            factory.create(PROXY_URL, options);
            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;

            expect(() => clientFactory(new URL('https://target.com'))).toThrow('Factory invocation failed');
        });

        it('does not mutate the input options object', () => {
            const originalOptions = makeOptions();

            factory.create(PROXY_URL, originalOptions);

            expect(originalOptions).toStrictEqual(makeOptions());
        });

        it('wires the agent so that transport.close() delegates to agent.close()', async () => {
            const result = factory.create(PROXY_URL, options);
            await result.close();
            expect(mockAgent.close).toHaveBeenCalledTimes(1);
        });

        it('reuses the same poolFactory for multiple clientFactory invocations', () => {
            factory.create(PROXY_URL, options);
            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;

            clientFactory(new URL('https://a.com'));
            clientFactory(new URL('https://b.com'));

            expect(mockPoolFactory).toHaveBeenCalledTimes(2);
        });

        it('isolates resolved connections between create() calls', () => {
            mockResolveConnections.mockReturnValueOnce(1).mockReturnValueOnce(99);

            factory.create('http://proxy-a:8080', makeOptions());
            const [, clientFactoryA] = mockAgentCreator.mock.calls[0]!;

            factory.create('http://proxy-b:9090', makeOptions());
            const [, clientFactoryB] = mockAgentCreator.mock.calls[1]!;

            clientFactoryA(new URL('https://target.com'));
            clientFactoryB(new URL('https://target.com'));

            expect(mockPoolFactory).toHaveBeenNthCalledWith(1, expect.any(URL), { connections: 1 });
            expect(mockPoolFactory).toHaveBeenNthCalledWith(2, expect.any(URL), { connections: 99 });
        });

        it('returns the pool from poolFactory through clientFactory', () => {
            const mockPool = { symbol: 'dispatcher' } as unknown as Dispatcher;
            mockPoolFactory.mockReturnValue(mockPool);
            factory.create(PROXY_URL, options);
            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;

            const result = clientFactory(new URL('https://target.com'));
            expect(result).toBe(mockPool);
        });

        it('calls resolveConnections with proxyCount, concurrency, and poolConfig', () => {
            factory.create(PROXY_URL, options);

            expect(mockResolveConnections).toHaveBeenCalledTimes(1);
            expect(mockResolveConnections).toHaveBeenCalledWith(
                options.proxyCount,
                options.concurrency,
                options.poolConfig,
            );
        });

        it('calls poolCreator with the pool config', () => {
            factory.create(PROXY_URL, options);

            expect(mockPoolCreator).toHaveBeenCalledTimes(1);
            expect(mockPoolCreator).toHaveBeenCalledWith(options.poolConfig);
        });

        it('calls agentCreator with the proxy URL', () => {
            factory.create(PROXY_URL, options);

            const [uri] = mockAgentCreator.mock.calls[0]!;
            expect(uri).toBe(PROXY_URL);
        });

        it('passes a callable clientFactory as the second arg to agentCreator', () => {
            factory.create(PROXY_URL, options);

            const [, clientFactory] = mockAgentCreator.mock.calls[0]!;
            expect(clientFactory).toEqual(expect.any(Function));
        });

        it('returns a UndiciHttpTransport', () => {
            const result = factory.create(PROXY_URL, options);

            expect(result).toBeInstanceOf(UndiciHttpTransport);
        });

        describe('clientFactory (captured from agentCreator call)', () => {
            let clientFactory: PoolClientFactory;

            beforeEach(() => {
                factory.create(PROXY_URL, options);
                // Pull the closure that was handed to agentCreator
                clientFactory = mockAgentCreator.mock.calls[0]![1] as PoolClientFactory;
            });

            it('calls poolFactory with origin and opts merged with resolved connections', () => {
                const origin = new URL('https://target.example.com');
                const extraOpts = { keepAliveTimeout: 30_000 };

                clientFactory(origin, extraOpts);

                expect(mockPoolFactory).toHaveBeenCalledTimes(1);
                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    keepAliveTimeout: 30_000,
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('injects connections even when no extra opts are supplied', () => {
                const origin = new URL('https://target.example.com');

                clientFactory(origin);

                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    connections: RESOLVED_CONNECTIONS,
                });
            });

            it('resolved connections value wins over a caller-supplied connections key', () => {
                const origin = new URL('https://target.example.com');

                // Caller tries to override — the injected value must still win
                clientFactory(origin, { connections: 9999 });

                expect(mockPoolFactory).toHaveBeenCalledWith(origin, {
                    connections: RESOLVED_CONNECTIONS,
                });
            });
        });
    });

    describe('constructor', () => {
        it('instantiates without seams using production defaults', () => {
            // Smoke test: verifies the default seam wiring compiles and the
            // instance is created without error. We do not call create() here
            // to avoid real socket construction.
            expect(() => new UndiciTransportFactory()).not.toThrow();
        });
    });
});
