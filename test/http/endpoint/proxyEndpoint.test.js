import {beforeEach, describe, expect, jest, test} from '@jest/globals';

const ProxyAgentMock = jest.fn(function ProxyAgent(opts) {
});

jest.unstable_mockModule('undici', () => ({
    ProxyAgent: ProxyAgentMock,
}));

const poolFactoryMock = jest.fn();
const createPoolFactoryMock = jest.fn(() => poolFactoryMock);

jest.unstable_mockModule('../../../src/http/poolFactory.js', () => ({
    createPoolFactory: createPoolFactoryMock,
}));

const {ProxyEndpoint} = await import('../../../src/http/endpoint/proxyEndpoint.js');
const {Endpoint} = await import('../../../src/http/endpoint/endpoint.js');

const samplePoolConfig = Object.freeze({
    connections: 10,
    maxConnections: 50,
    pipelining: 1,
    keepAliveTimeout: 4_000,
    headersTimeout: 30_000,
    bodyTimeout: 30_000,
    connectTimeout: 5_000,
});

describe('ProxyEndpoint', () => {
    beforeEach(() => {
        ProxyAgentMock.mockClear();
        poolFactoryMock.mockClear();
        createPoolFactoryMock.mockClear();
    });

    describe('Constructor & ProxyAgent Setup', () => {
        test('extends Endpoint class', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});
            expect(endpoint).toBeInstanceOf(ProxyEndpoint);
            expect(endpoint).toBeInstanceOf(Endpoint);
        });

        test('constructs a ProxyAgent with uri set to proxy url and clientFactory that delegates to poolFactory', () => {
            const proxyUrl = 'http://u:p@1.2.3.4:80';

            new ProxyEndpoint(proxyUrl, null, {poolConfig: samplePoolConfig});

            expect(ProxyAgentMock).toHaveBeenCalledTimes(1);

            const options = ProxyAgentMock.mock.calls[0][0];

            expect(options.uri).toBe(proxyUrl);
            expect(options.clientFactory).toEqual(expect.any(Function));

            const origin = 'https://example.com';
            const poolOptions = {foo: 'bar'};

            options.clientFactory(origin, poolOptions);

            expect(poolFactoryMock).toHaveBeenCalledWith(
                origin,
                expect.objectContaining({
                    foo: 'bar',
                    connections: expect.any(Number),
                }),
            );
        });

        test('creates the pool factory once via createPoolFactory, passing the supplied poolConfig', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});

            expect(createPoolFactoryMock).toHaveBeenCalledTimes(1);
            expect(createPoolFactoryMock).toHaveBeenCalledWith(samplePoolConfig);
        });

        test('is frozen on instantiation (instance immutability)', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});
            expect(Object.isFrozen(endpoint)).toBe(true);

            expect(() => {
                'use strict';
                endpoint.customProp = 'test';
            }).toThrow(TypeError);
        });
    });

    describe('getHandle()', () => {
        test('returns handle object containing proxy url and ProxyAgent dispatcher instance', () => {
            const proxyUrl = 'http://u:p@1.2.3.4:80';
            const endpoint = new ProxyEndpoint(proxyUrl, null, {poolConfig: samplePoolConfig});
            const handle = endpoint.getHandle();

            expect(handle.url).toBe(proxyUrl);
            expect(handle.dispatcher).toBeInstanceOf(ProxyAgentMock);
        });

        test('returns a frozen handle object', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});
            const handle = endpoint.getHandle();

            expect(Object.isFrozen(handle)).toBe(true);
            expect(() => {
                'use strict';
                handle.url = 'mutated';
            }).toThrow(TypeError);
            expect(() => {
                'use strict';
                handle.dispatcher = {};
            }).toThrow(TypeError);
        });

        test('always returns exact same handle reference across multiple calls without recreating ProxyAgent', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});
            const handle1 = endpoint.getHandle();
            const handle2 = endpoint.getHandle();

            expect(handle1).toBe(handle2);
            expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
        });

        test('each ProxyEndpoint instance receives its own distinct ProxyAgent and handle', () => {
            const endpointA = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});
            const endpointB = new ProxyEndpoint('http://u:p@5.6.7.8:81', null, {poolConfig: samplePoolConfig});

            const handleA = endpointA.getHandle();
            const handleB = endpointB.getHandle();

            expect(handleA).not.toBe(handleB);
            expect(handleA.dispatcher).not.toBe(handleB.dispatcher);
            expect(ProxyAgentMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('Rate Limiter Integration', () => {
        test('defaults to unrestricted access when no limiter is provided', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});

            expect(endpoint.tryAcquire()).toBe(true);
            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('defaults to unrestricted access when limiter is explicitly null or undefined', () => {
            const endpointNull = new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});
            const endpointUndefined = new ProxyEndpoint('http://u:p@1.2.3.4:80', undefined, {poolConfig: samplePoolConfig});

            expect(endpointNull.tryAcquire()).toBe(true);
            expect(endpointNull.timeUntilToken()).toBe(0);

            expect(endpointUndefined.tryAcquire()).toBe(true);
            expect(endpointUndefined.timeUntilToken()).toBe(0);
        });

        test('delegates tryAcquire() and timeUntilToken() to the supplied limiter', () => {
            const limiter = {
                tryAcquire: jest.fn(() => false),
                timeUntilToken: jest.fn(() => 999),
            };
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', limiter, {poolConfig: samplePoolConfig});

            expect(endpoint.tryAcquire()).toBe(false);
            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);

            expect(endpoint.timeUntilToken()).toBe(999);
            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
        });

        test('propagates errors thrown by the rate limiter', () => {
            const limiter = {
                tryAcquire: jest.fn(() => {
                    throw new Error('Limiter acquire error');
                }),
                timeUntilToken: jest.fn(() => {
                    throw new Error('Limiter token error');
                }),
            };
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', limiter, {poolConfig: samplePoolConfig});

            expect(() => endpoint.tryAcquire()).toThrow('Limiter acquire error');
            expect(() => endpoint.timeUntilToken()).toThrow('Limiter token error');
        });
    });

    describe('Pool connection sizing (#resolveConnections)', () => {
        const getConnectionsPassedToPool = () => {
            const options = ProxyAgentMock.mock.calls[0][0];
            options.clientFactory('https://example.com', {});
            return poolFactoryMock.mock.calls[0][1].connections;
        };

        test('falls back to poolConfig.connections when concurrency is not provided', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {poolConfig: samplePoolConfig});

            expect(getConnectionsPassedToPool()).toBe(samplePoolConfig.connections);
        });

        test('falls back to poolConfig.connections when proxyCount is 0', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {
                proxyCount: 0,
                concurrency: 500,
                poolConfig: samplePoolConfig,
            });

            expect(getConnectionsPassedToPool()).toBe(samplePoolConfig.connections);
        });

        test('computes ceil(concurrency / proxyCount) when within [connections, maxConnections] bounds', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {
                proxyCount: 2,
                concurrency: 40, // 40 / 2 = 20, between 10 and 50
                poolConfig: samplePoolConfig,
            });

            expect(getConnectionsPassedToPool()).toBe(20);
        });

        test('clamps up to poolConfig.connections when computed target is below the floor', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {
                proxyCount: 100,
                concurrency: 50, // 50 / 100 = 1, below floor of 10
                poolConfig: samplePoolConfig,
            });

            expect(getConnectionsPassedToPool()).toBe(samplePoolConfig.connections);
        });

        test('clamps down to poolConfig.maxConnections when computed target exceeds the ceiling', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {
                proxyCount: 1,
                concurrency: 500, // 500 / 1 = 500, above ceiling of 50
                poolConfig: samplePoolConfig,
            });

            expect(getConnectionsPassedToPool()).toBe(samplePoolConfig.maxConnections);
        });

        test('rounds up (ceil) rather than down for non-integer division', () => {
            new ProxyEndpoint('http://u:p@1.2.3.4:80', null, {
                proxyCount: 3,
                concurrency: 61, // 61 / 3 = 20.33... -> ceil = 21
                poolConfig: samplePoolConfig,
            });

            expect(getConnectionsPassedToPool()).toBe(21);
        });
    });
});