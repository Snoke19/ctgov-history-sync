import {describe, expect, jest, test} from '@jest/globals';
import {Endpoint} from "../../../src/http/endpoint/endpoint.js";
import {UnlimitedLimiter} from "../../../src/http/limiter/unlimitedLimiter.js";

describe('Endpoint', () => {
    describe('url', () => {
        test('exposes the url it was constructed with', () => {
            const endpoint = new Endpoint('https://example.com', null);
            expect(endpoint.url).toBe('https://example.com');
        });
    });

    describe('tryAcquire()', () => {
        test('returns true unconditionally when no limiter is provided', () => {
            const endpoint = new Endpoint('url', null);
            expect(endpoint.tryAcquire()).toBe(true);
        });

        test('returns true unconditionally when limiter is undefined', () => {
            const endpoint = new Endpoint('url');
            expect(endpoint.tryAcquire()).toBe(true);
        });

        test('delegates to limiter.tryAcquire() when a limiter is provided', () => {
            const limiter = {
                tryAcquire: jest.fn(() => false),
            };
            const endpoint = new Endpoint('url', limiter);

            expect(endpoint.tryAcquire()).toBe(false);
            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);
        });

        test('propagates whatever the limiter returns, without transforming it', () => {
            const limiter = {
                tryAcquire: jest.fn(() => true)
            };
            const endpoint = new Endpoint('url', limiter);
            expect(endpoint.tryAcquire()).toBe(true);
        });
    });

    describe('timeUntilToken()', () => {
        test('returns 0 when no limiter is provided', () => {
            const endpoint = new Endpoint('url', null);
            expect(endpoint.timeUntilToken()).toBe(0);
        });

        test('delegates to limiter.timeUntilToken()', () => {
            const limiter = {
                tryAcquire: jest.fn(),
                timeUntilToken: jest.fn(() => 1234)
            };
            const endpoint = new Endpoint('url', limiter);

            expect(endpoint.timeUntilToken()).toBe(1234);
            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
        });

        test('works with the real UnlimitedLimiter (regression)', () => {
            const endpoint = new Endpoint('url', new UnlimitedLimiter());
            expect(endpoint.timeUntilToken()).toBe(0);
        });
    });

    describe('getHandle()', () => {
        test('throws because subclasses must implement it', () => {
            const endpoint = new Endpoint('url', null);
            expect(() => endpoint.getHandle()).toThrow('getHandle() must be implemented');
        });
    });
});