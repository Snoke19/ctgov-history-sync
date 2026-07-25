import {describe, expect, jest, test} from '@jest/globals';
import {DirectEndpoint} from '../../../src/http/endpoint/directEndpoint.js';
import {Endpoint} from '../../../src/http/endpoint/endpoint.js';

describe('DirectEndpoint', () => {
    describe('Constructor & Instance Immutability', () => {
        test('extends Endpoint class', () => {
            const endpoint = new DirectEndpoint();
            expect(endpoint).toBeInstanceOf(DirectEndpoint);
            expect(endpoint).toBeInstanceOf(Endpoint);
        });

        test('defaults url to "direct" when no parameters are provided', () => {
            const endpoint = new DirectEndpoint();
            expect(endpoint.url).toBe('direct');
        });

        test('accepts a custom url string', () => {
            const endpoint = new DirectEndpoint('http://custom-direct-url');
            expect(endpoint.url).toBe('http://custom-direct-url');
        });

        test('handles empty string url', () => {
            const endpoint = new DirectEndpoint('');
            expect(endpoint.url).toBe('');
        });

        test('is frozen on instantiation (instance immutability)', () => {
            const endpoint = new DirectEndpoint();
            expect(Object.isFrozen(endpoint)).toBe(true);

            expect(() => {
                'use strict';
                endpoint.customProp = 'test';
            }).toThrow(TypeError);
        });
    });

    describe('getHandle()', () => {
        test('returns a handle object with url and dispatcher undefined', () => {
            const endpoint = new DirectEndpoint('custom-url');
            const handle = endpoint.getHandle();

            expect(handle).toEqual({
                url: 'custom-url',
                dispatcher: undefined,
            });
            expect(handle.dispatcher).toBeUndefined();
        });

        test('returns a frozen handle object', () => {
            const endpoint = new DirectEndpoint();
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

        test('always returns the exact same handle instance reference across multiple calls', () => {
            const endpoint = new DirectEndpoint();
            const handle1 = endpoint.getHandle();
            const handle2 = endpoint.getHandle();

            expect(handle1).toBe(handle2);
        });

        test('different DirectEndpoint instances return distinct handle instances', () => {
            const endpoint1 = new DirectEndpoint('url-1');
            const endpoint2 = new DirectEndpoint('url-2');

            const handle1 = endpoint1.getHandle();
            const handle2 = endpoint2.getHandle();

            expect(handle1).not.toBe(handle2);
            expect(handle1.url).toBe('url-1');
            expect(handle2.url).toBe('url-2');
        });
    });

    describe('Rate Limiter Integration', () => {
        test('defaults to unrestricted access when no limiter is provided', () => {
            const endpoint = new DirectEndpoint('direct');

            expect(endpoint.tryAcquire()).toBe(true);
            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('defaults to unrestricted access when limiter is explicitly null or undefined', () => {
            const endpointNull = new DirectEndpoint('direct', null);
            const endpointUndefined = new DirectEndpoint('direct', undefined);

            expect(endpointNull.tryAcquire()).toBe(true);
            expect(endpointNull.timeUntilToken()).toBe(0);

            expect(endpointUndefined.tryAcquire()).toBe(true);
            expect(endpointUndefined.timeUntilToken()).toBe(0);
        });

        test('delegates tryAcquire() and timeUntilToken() to the supplied limiter', () => {
            const limiter = {
                tryAcquire: jest.fn(() => false),
                timeUntilToken: jest.fn(() => 1500),
            };
            const endpoint = new DirectEndpoint('direct', limiter);

            expect(endpoint.tryAcquire()).toBe(false);
            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);

            expect(endpoint.timeUntilToken()).toBe(1500);
            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
        });

        test('propagates errors if the limiter throws', () => {
            const limiter = {
                tryAcquire: jest.fn(() => {
                    throw new Error('Limiter failure');
                }),
                timeUntilToken: jest.fn(() => {
                    throw new Error('Limiter calculation failure');
                }),
            };
            const endpoint = new DirectEndpoint('direct', limiter);

            expect(() => endpoint.tryAcquire()).toThrow('Limiter failure');
            expect(() => endpoint.timeUntilToken()).toThrow('Limiter calculation failure');
        });
    });
});