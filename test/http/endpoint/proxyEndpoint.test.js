import {beforeEach, describe, expect, jest, test} from '@jest/globals';

const ProxyAgentMock = jest.fn(function ProxyAgent(opts) {
    this.opts = opts;
});

jest.unstable_mockModule('undici', () => ({
    ProxyAgent: ProxyAgentMock,
}));

const poolFactoryMock = jest.fn();

jest.unstable_mockModule('../../../src/http/poolFactory.js', () => ({
    poolFactory: poolFactoryMock,
}));

const { ProxyEndpoint } = await import('../../../src/http/endpoint/proxyEndpoint.js');
const { Endpoint } = await import('../../../src/http/endpoint/endpoint.js');

describe('ProxyEndpoint', () => {
    beforeEach(() => {
        ProxyAgentMock.mockClear();
    });

    describe('Constructor & ProxyAgent Setup', () => {
        test('extends Endpoint class', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
            expect(endpoint).toBeInstanceOf(ProxyEndpoint);
            expect(endpoint).toBeInstanceOf(Endpoint);
        });

        test('constructs a ProxyAgent with uri set to proxy url and poolFactory as clientFactory', () => {
            const proxyUrl = 'http://u:p@1.2.3.4:80';
            new ProxyEndpoint(proxyUrl);

            expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
            expect(ProxyAgentMock).toHaveBeenCalledWith({
                uri: proxyUrl,
                clientFactory: poolFactoryMock,
            });
        });

        test('is frozen on instantiation (instance immutability)', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
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
            const endpoint = new ProxyEndpoint(proxyUrl);
            const handle = endpoint.getHandle();

            expect(handle.url).toBe(proxyUrl);
            expect(handle.dispatcher).toBeInstanceOf(ProxyAgentMock);
        });

        test('returns a frozen handle object', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
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
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
            const handle1 = endpoint.getHandle();
            const handle2 = endpoint.getHandle();

            expect(handle1).toBe(handle2);
            expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
        });

        test('each ProxyEndpoint instance receives its own distinct ProxyAgent and handle', () => {
            const endpointA = new ProxyEndpoint('http://u:p@1.2.3.4:80');
            const endpointB = new ProxyEndpoint('http://u:p@5.6.7.8:81');

            const handleA = endpointA.getHandle();
            const handleB = endpointB.getHandle();

            expect(handleA).not.toBe(handleB);
            expect(handleA.dispatcher).not.toBe(handleB.dispatcher);
            expect(ProxyAgentMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('Rate Limiter Integration', () => {
        test('defaults to unrestricted access when no limiter is provided', () => {
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');

            expect(endpoint.tryAcquire()).toBe(true);
            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('defaults to unrestricted access when limiter is explicitly null or undefined', () => {
            const endpointNull = new ProxyEndpoint('http://u:p@1.2.3.4:80', null);
            const endpointUndefined = new ProxyEndpoint('http://u:p@1.2.3.4:80', undefined);

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
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', limiter);

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
            const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', limiter);

            expect(() => endpoint.tryAcquire()).toThrow('Limiter acquire error');
            expect(() => endpoint.timeUntilToken()).toThrow('Limiter token error');
        });
    });
});
