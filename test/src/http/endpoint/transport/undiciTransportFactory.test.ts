import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProxyPoolConfig } from '../../../../../src/config/config.js';
import { CreateProxyEndpointsOptions } from '../../../../../src/http/endpoint/transport/httpTransport.js';

import type {
    AgentCreatorFn,
    PoolClientFactory,
    PoolCreatorFn,
    UndiciTransportFactory as UndiciTransportFactoryType,
} from '../../../../../src/http/endpoint/transport/impl/undiciProxyTransport.js';
import { ProxyAgent } from 'undici';

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
