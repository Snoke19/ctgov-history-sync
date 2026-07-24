import {describe, expect, jest, test} from '@jest/globals';
import {Endpoint} from '../../../src/http/endpoint/endpoint.js';
import {UnlimitedLimiter} from '../../../src/http/limiter/unlimitedLimiter.js';

class TestEndpoint extends Endpoint {
    getHandle() {
        throw new Error('Not used in this test');
    }
}

describe('Endpoint', () => {
    describe('constructor', () => {
        test('cannot be instantiated directly', () => {
            expect(() => new Endpoint('url'))
                .toThrow('Endpoint is abstract and cannot be instantiated directly');
        });
    });

    describe('url', () => {
        test('exposes the url it was constructed with', () => {
            const endpoint = new TestEndpoint('https://example.com');

            expect(endpoint.url).toBe('https://example.com');
        });
    });

    describe('tryAcquire()', () => {
        test('returns true when no limiter is provided', () => {
            const endpoint = new TestEndpoint('url');

            expect(endpoint.tryAcquire()).toBe(true);
        });

        test('delegates to limiter.tryAcquire()', () => {
            const limiter = {
                tryAcquire: jest.fn(() => false),
            };

            const endpoint = new TestEndpoint('url', limiter);

            expect(endpoint.tryAcquire()).toBe(false);
            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);
        });
    });

    describe('timeUntilToken()', () => {
        test('returns 0 when no limiter is provided', () => {
            const endpoint = new TestEndpoint('url');

            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('delegates to limiter.timeUntilToken()', () => {
            const limiter = {
                tryAcquire: jest.fn(),
                timeUntilToken: jest.fn(() => 1234),
            };

            const endpoint = new TestEndpoint('url', limiter);

            expect(endpoint.timeUntilToken()).toBe(1234);
            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
        });

        test('works with UnlimitedLimiter', () => {
            const endpoint = new TestEndpoint('url', new UnlimitedLimiter());

            expect(endpoint.timeUntilToken()).toBe(0);
        });
    });
});