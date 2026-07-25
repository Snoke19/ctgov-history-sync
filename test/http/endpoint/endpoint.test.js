import {describe, expect, jest, test} from '@jest/globals';
import {Endpoint} from '../../../src/http/endpoint/endpoint.js';
import {UnlimitedLimiter} from '../../../src/http/limiter/unlimitedLimiter.js';

class ConcreteEndpoint extends Endpoint {
    getHandle() {
        return {url: this.url, dispatcher: undefined};
    }
}

class UnimplementedEndpoint extends Endpoint {}

describe('Endpoint', () => {
    describe('Constructor & Abstract Class Constraints', () => {
        test('throws TypeError when instantiated directly', () => {
            expect(() => new Endpoint('https://example.com')).toThrow(TypeError);
            expect(() => new Endpoint('https://example.com')).toThrow(
                'Endpoint is abstract and cannot be instantiated directly',
            );
        });

        test('can be instantiated by a concrete subclass', () => {
            const endpoint = new ConcreteEndpoint('https://example.com');
            expect(endpoint).toBeInstanceOf(Endpoint);
            expect(endpoint).toBeInstanceOf(ConcreteEndpoint);
        });

        test('freezes the instance on construction (instance immutability)', () => {
            const endpoint = new ConcreteEndpoint('https://example.com');
            expect(Object.isFrozen(endpoint)).toBe(true);

            expect(() => {
                'use strict';
                endpoint.newProperty = 'test';
            }).toThrow(TypeError);
        });
    });

    describe('url getter', () => {
        test('exposes the exact url string provided at construction', () => {
            const endpoint = new ConcreteEndpoint('https://api.clinicaltrials.gov');
            expect(endpoint.url).toBe('https://api.clinicaltrials.gov');
        });

        test('handles empty string url', () => {
            const endpoint = new ConcreteEndpoint('');
            expect(endpoint.url).toBe('');
        });

        test('handles null and undefined url values', () => {
            const endpointNull = new ConcreteEndpoint(null);
            const endpointUndefined = new ConcreteEndpoint(undefined);

            expect(endpointNull.url).toBeNull();
            expect(endpointUndefined.url).toBeUndefined();
        });

        test('url getter is read-only and cannot be reassigned', () => {
            const endpoint = new ConcreteEndpoint('https://example.com');

            expect(() => {
                'use strict';
                endpoint.url = 'https://other.com';
            }).toThrow(TypeError);
        });
    });

    describe('getHandle() abstract method', () => {
        test('throws Error when getHandle() is not implemented by subclass', () => {
            const endpoint = new UnimplementedEndpoint('https://example.com');

            expect(() => endpoint.getHandle()).toThrow(Error);
            expect(() => endpoint.getHandle()).toThrow('getHandle() must be implemented');
        });

        test('executes subclass implementation when getHandle() is overridden', () => {
            const endpoint = new ConcreteEndpoint('https://example.com');

            expect(endpoint.getHandle()).toEqual({
                url: 'https://example.com',
                dispatcher: undefined,
            });
        });
    });

    describe('tryAcquire()', () => {
        test('returns true unconditionally when no limiter is provided', () => {
            const endpoint = new ConcreteEndpoint('url');
            expect(endpoint.tryAcquire()).toBe(true);
        });

        test('returns true unconditionally when limiter is explicitly null or undefined', () => {
            const endpointNull = new ConcreteEndpoint('url', null);
            const endpointUndefined = new ConcreteEndpoint('url', undefined);

            expect(endpointNull.tryAcquire()).toBe(true);
            expect(endpointUndefined.tryAcquire()).toBe(true);
        });

        test('delegates tryAcquire() to the provided limiter', () => {
            const limiter = {
                tryAcquire: jest.fn(() => false),
            };
            const endpoint = new ConcreteEndpoint('url', limiter);

            expect(endpoint.tryAcquire()).toBe(false);
            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('propagates errors thrown by limiter.tryAcquire()', () => {
            const limiter = {
                tryAcquire: jest.fn(() => {
                    throw new Error('Limiter tryAcquire failed');
                }),
            };
            const endpoint = new ConcreteEndpoint('url', limiter);

            expect(() => endpoint.tryAcquire()).toThrow('Limiter tryAcquire failed');
        });
    });

    describe('timeUntilToken()', () => {
        test('returns 0 when no limiter is provided', () => {
            const endpoint = new ConcreteEndpoint('url');
            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('returns 0 when limiter is explicitly null or undefined', () => {
            const endpointNull = new ConcreteEndpoint('url', null);
            const endpointUndefined = new ConcreteEndpoint('url', undefined);

            expect(endpointNull.timeUntilToken()).toBe(0);
            expect(endpointUndefined.timeUntilToken()).toBe(0);
        });

        test('delegates timeUntilToken() to the provided limiter', () => {
            const limiter = {
                tryAcquire: jest.fn(),
                timeUntilToken: jest.fn(() => 5000),
            };
            const endpoint = new ConcreteEndpoint('url', limiter);

            expect(endpoint.timeUntilToken()).toBe(5000);
            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
        });

        test('works seamlessly with UnlimitedLimiter instance', () => {
            const endpoint = new ConcreteEndpoint('url', new UnlimitedLimiter());

            expect(endpoint.tryAcquire()).toBe(true);
            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('propagates errors thrown by limiter.timeUntilToken()', () => {
            const limiter = {
                timeUntilToken: jest.fn(() => {
                    throw new Error('Limiter timeUntilToken failed');
                }),
            };
            const endpoint = new ConcreteEndpoint('url', limiter);

            expect(() => endpoint.timeUntilToken()).toThrow('Limiter timeUntilToken failed');
        });
    });
});