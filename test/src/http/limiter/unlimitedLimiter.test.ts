import {describe, expect, it} from '@jest/globals';
import {UnlimitedLimiter} from '../../../../src/http/limiter/unlimitedLimiter.js';
import {Limiter} from '../../../../src/http/limiter/limiter.js';

describe('UnlimitedLimiter', () => {
    describe('construction', () => {
        it('constructs without throwing', () => {
            expect(() => new UnlimitedLimiter()).not.toThrow();
        });

        it('is an instance of both UnlimitedLimiter and its base Limiter class', () => {
            const limiter = new UnlimitedLimiter();
            expect(limiter).toBeInstanceOf(UnlimitedLimiter);
            expect(limiter).toBeInstanceOf(Limiter);
        });
    });

    describe('tryAcquire', () => {
        it('returns true for a typical timestamp', () => {
            const limiter = new UnlimitedLimiter();
            expect(limiter.tryAcquire(0)).toBe(true);
        });

        it.each([0, 1, 1000, Number.MAX_SAFE_INTEGER, -1, NaN, Infinity, -Infinity])(
            'returns true regardless of the `now` value passed: %p',
            (now) => {
                const limiter = new UnlimitedLimiter();
                expect(limiter.tryAcquire(now)).toBe(true);
            },
        );

        it('returns true on every call in a tight loop — never throttles, never depends on prior calls', () => {
            const limiter = new UnlimitedLimiter();
            for (let i = 0; i < 10_000; i++) {
                expect(limiter.tryAcquire(i)).toBe(true);
            }
        });

        it('returns true even when called many times at the exact same instant', () => {
            const limiter = new UnlimitedLimiter();
            const now = 12345;
            for (let i = 0; i < 100; i++) {
                expect(limiter.tryAcquire(now)).toBe(true);
            }
        });

        it('has no shared state between separate instances', () => {
            const a = new UnlimitedLimiter();
            const b = new UnlimitedLimiter();
            expect(a.tryAcquire(0)).toBe(true);
            expect(b.tryAcquire(0)).toBe(true);
            // exhausting `a` (if it had any state) must not affect `b`
            for (let i = 0; i < 1000; i++) a.tryAcquire(i);
            expect(b.tryAcquire(0)).toBe(true);
        });
    });

    describe('timeUntilToken', () => {
        it('returns 0 for a typical timestamp', () => {
            const limiter = new UnlimitedLimiter();
            expect(limiter.timeUntilToken(0)).toBe(0);
        });

        it.each([0, 1, 1000, Number.MAX_SAFE_INTEGER, -1, NaN, Infinity, -Infinity])(
            'returns 0 regardless of the `now` value passed: %p',
            (now) => {
                const limiter = new UnlimitedLimiter();
                expect(limiter.timeUntilToken(now)).toBe(0);
            },
        );

        it('returns 0 consistently across repeated calls, independent of prior tryAcquire calls', () => {
            const limiter = new UnlimitedLimiter();
            for (let i = 0; i < 100; i++) limiter.tryAcquire(i);
            expect(limiter.timeUntilToken(0)).toBe(0);
        });
    });
});