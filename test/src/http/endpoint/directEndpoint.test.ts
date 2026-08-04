import {describe, expect, jest, test} from '@jest/globals';
import {DirectEndpoint} from '../../../../src/http/endpoint/direct/directEndpoint.js';
import {Endpoint} from '../../../../src/http/endpoint/endpoint.js';
import {UnlimitedLimiter} from "../../../../src/http/limiter/unlimitedLimiter.js";

describe('DirectEndpoint', () => {
    describe('Constructor & Identity', () => {
        test('is a concrete subclass of Endpoint', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());

            expect(endpoint).toBeInstanceOf(DirectEndpoint);
            expect(endpoint).toBeInstanceOf(Endpoint);
        });

        test('always uses the constant URL "direct"', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());

            expect(endpoint.getUrl()).toBe('direct');
        });

        test('throws at runtime if constructed without a limiter', () => {
            // TypeScript blocks this, but the runtime guard (or lack thereof) is worth asserting
            expect(() => new (DirectEndpoint as any)()).toThrow();
        });
    });

    describe('getHandle()', () => {
        test('returns a frozen handle with url="direct" and dispatcher=null', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());
            const handle = endpoint.getHandle();

            expect(handle).toEqual({
                url: 'direct',
                dispatcher: null,
            });
            expect(handle.dispatcher).toBeNull(); // strict null, not undefined
            expect(Object.isFrozen(handle)).toBe(true);
        });

        test('memoizes the handle (same reference on every call)', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());
            const handle1 = endpoint.getHandle();
            const handle2 = endpoint.getHandle();
            const handle3 = endpoint.getHandle();

            expect(handle1).toBe(handle2);
            expect(handle2).toBe(handle3);
        });

        test('isolates handles between instances', () => {
            const endpoint1 = new DirectEndpoint(new UnlimitedLimiter());
            const endpoint2 = new DirectEndpoint(new UnlimitedLimiter());

            const handle1 = endpoint1.getHandle();
            const handle2 = endpoint2.getHandle();

            expect(handle1).not.toBe(handle2);
            expect(handle1.url).toBe(handle2.url);
        });

        test('handle.url always mirrors getUrl()', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());

            expect(endpoint.getHandle().url).toBe(endpoint.getUrl());
        });

        test('handle is immutable (frozen in strict mode)', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());
            const handle = endpoint.getHandle();

            expect(() => {
                (handle as any).url = 'tampered';
            }).toThrow();

            expect(() => {
                (handle as any).dispatcher = {} as any;
            }).toThrow();

            // Verify values remain intact after mutation attempts
            expect(handle.url).toBe('direct');
            expect(handle.dispatcher).toBeNull();
        });
    });

    describe('Rate Limiter Delegation', () => {
        test('forwards tryAcquire(now) to the injected limiter and returns its result', () => {
            const limiter = {
                tryAcquire: jest.fn((_now: number) => false),
                timeUntilToken: jest.fn(() => 0),
            };
            const endpoint = new DirectEndpoint(limiter as any);

            const result = endpoint.tryAcquire(1_000);

            expect(result).toBe(false);
            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);
            expect(limiter.tryAcquire).toHaveBeenCalledWith(1_000);
        });

        test('forwards timeUntilToken(now) to the injected limiter and returns its result', () => {
            const limiter = {
                tryAcquire: jest.fn(() => true),
                timeUntilToken: jest.fn((_now: number) => 2_500),
            };
            const endpoint = new DirectEndpoint(limiter as any);

            const result = endpoint.timeUntilToken(5_000);

            expect(result).toBe(2_500);
            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
            expect(limiter.timeUntilToken).toHaveBeenCalledWith(5_000);
        });

        test('works with UnlimitedLimiter (always allows, zero wait)', () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());

            expect(endpoint.tryAcquire(Date.now())).toBe(true);
            expect(endpoint.timeUntilToken(Date.now())).toBe(0);
        });

        test('propagates errors thrown by the limiter without swallowing', () => {
            const tryError = new Error('Acquire failure');
            const timeError = new Error('Token calculation failure');

            const limiter = {
                tryAcquire: jest.fn(() => {
                    throw tryError;
                }),
                timeUntilToken: jest.fn(() => {
                    throw timeError;
                }),
            };
            const endpoint = new DirectEndpoint(limiter as any);

            expect(() => endpoint.tryAcquire(1)).toThrow(tryError);
            expect(() => endpoint.timeUntilToken(1)).toThrow(timeError);
        });

        test('does not cache or alter limiter return values', () => {
            const limiter = {
                tryAcquire: jest.fn(() => true),
                timeUntilToken: jest.fn(() => 999),
            };
            const endpoint = new DirectEndpoint(limiter as any);

            expect(endpoint.tryAcquire(0)).toBe(true);
            expect(endpoint.timeUntilToken(0)).toBe(999);
        });
    });

    describe('Lifecycle', () => {
        test('close() resolves to undefined immediately', async () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());

            await expect(endpoint.close()).resolves.toBeUndefined();
        });

        test('close() does not invalidate or alter the handle', async () => {
            const endpoint = new DirectEndpoint(new UnlimitedLimiter());
            const handleBefore = endpoint.getHandle();

            await endpoint.close();

            const handleAfter = endpoint.getHandle();
            expect(handleAfter).toBe(handleBefore);
            expect(handleAfter.url).toBe('direct');
            expect(handleAfter.dispatcher).toBeNull();
        });
    });
});
