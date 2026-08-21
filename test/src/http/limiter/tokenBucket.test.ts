import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TokenBucketTimeoutError } from '../../../../src/error/errors.js';
import { TokenBucket } from '../../../../src/http/limiter/impl/tokenBucket.js';

function makeClock(start = 0) {
    let t = start;
    return {
        now: (): number => t,
        advance(ms: number): void {
            t += ms;
        },
    };
}

describe('TokenBucket', () => {
    describe('construction', () => {
        it('accepts a valid capacity and windowMs', () => {
            expect(() => new TokenBucket({ capacity: 5, windowMs: 1000 })).not.toThrow();
        });

        it('starts full: peekTokens() equals capacity right after construction', () => {
            const bucket = new TokenBucket({ capacity: 5, windowMs: 1000 });
            expect(bucket.peekTokens()).toBe(5);
        });

        it.each([0, -1, 1.5, NaN, Infinity])('rejects a non-positive-integer capacity: %p', (capacity) => {
            expect(() => new TokenBucket({ capacity, windowMs: 1000 })).toThrow(TypeError);
        });

        it.each([0, -1, NaN, Infinity])('rejects a non-positive-finite windowMs: %p', (windowMs) => {
            expect(() => new TokenBucket({ capacity: 5, windowMs })).toThrow(TypeError);
        });

        it('accepts capacity = 1 (minimum valid value)', () => {
            expect(() => new TokenBucket({ capacity: 1, windowMs: 1000 })).not.toThrow();
        });
    });

    describe('tryAcquire', () => {
        it('allows exactly `capacity` immediate acquisitions at the same instant', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(false);
        });

        it('grants a token again only once enough time has passed', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.tryAcquire(999)).toBe(false);
            expect(bucket.tryAcquire(1000)).toBe(true);
        });

        it('does not grant two tokens for the same elapsed time window', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.tryAcquire(1000)).toBe(true);
            expect(bucket.tryAcquire(1000)).toBe(false);
        });

        it('accumulates partial credit correctly across multiple calls', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.tryAcquire(1000)).toBe(true);
            expect(bucket.tryAcquire(2500)).toBe(true);
            expect(bucket.tryAcquire(2500)).toBe(false);
        });

        it('never grants more than `capacity` tokens even after a very long idle period', () => {
            const bucket = new TokenBucket({ capacity: 3, windowMs: 3000, clock: () => 0 });
            expect(bucket.tryAcquire(1_000_000)).toBe(true);
            expect(bucket.tryAcquire(1_000_000)).toBe(true);
            expect(bucket.tryAcquire(1_000_000)).toBe(true);
            expect(bucket.tryAcquire(1_000_000)).toBe(false);
        });

        it('treats a `now` that goes backwards as zero elapsed time (no negative drain)', () => {
            const bucket = new TokenBucket({ capacity: 2, windowMs: 2000, clock: () => 0 });
            expect(bucket.tryAcquire(1000)).toBe(true);
            expect(bucket.tryAcquire(500)).toBe(true);
            expect(bucket.tryAcquire(500)).toBe(false);
        });

        it('is not fooled by floating-point dust when msPerToken is not a whole number', () => {
            const bucket = new TokenBucket({ capacity: 3, windowMs: 1000, clock: () => 0 });
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(false);
        });
    });

    describe('peekTokens', () => {
        it('is a pure read: calling it repeatedly does not consume tokens', () => {
            const bucket = new TokenBucket({ capacity: 3, windowMs: 3000, clock: () => 0 });
            expect(bucket.peekTokens()).toBe(3);
            expect(bucket.peekTokens()).toBe(3);
            expect(bucket.peekTokens()).toBe(3);
            expect(bucket.tryAcquire(0)).toBe(true);
        });

        it('reflects partial refill, floored down', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: clock.now });
            bucket.tryAcquire(clock.now());

            clock.advance(500);
            expect(bucket.peekTokens()).toBe(3);

            clock.advance(500);
            expect(bucket.peekTokens()).toBe(4);
        });

        it('caps at capacity and does not overflow, even long after full', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: clock.now });
            clock.advance(50_000);
            expect(bucket.peekTokens()).toBe(4);
        });

        it('drops to 0 immediately after fully draining the bucket', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket({ capacity: 2, windowMs: 2000, clock: clock.now });
            bucket.tryAcquire(clock.now());
            bucket.tryAcquire(clock.now());
            expect(bucket.peekTokens()).toBe(0);
        });
    });

    describe('timeUntil', () => {
        it('returns 0 for any count up to capacity while the bucket is full', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            expect(bucket.timeUntil(1, 0)).toBe(0);
            expect(bucket.timeUntil(4, 0)).toBe(0);
        });

        it('returns Infinity when count exceeds capacity — it can never be satisfied', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            expect(bucket.timeUntil(5, 0)).toBe(Infinity);
        });

        it('returns the exact wait time needed after the bucket is drained', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntil(1, 0)).toBe(1000);
            expect(bucket.timeUntil(1, 500)).toBe(500);
            expect(bucket.timeUntil(1, 1000)).toBe(0);
        });

        it('computes wait time proportionally for multi-token requests', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntil(2, 500)).toBe(1500);
        });

        it('never disagrees with tryAcquire about "available right now"', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntil(1, 1000)).toBe(0);
            expect(bucket.tryAcquire(1000)).toBe(true);
        });

        it.each([0, -1, NaN, Infinity])('rejects a non-positive-finite count: %p', (count) => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            expect(() => bucket.timeUntil(count, 0)).toThrow(TypeError);
        });
    });

    describe('timeUntilToken', () => {
        it('is equivalent to timeUntil(1, now)', () => {
            const bucket = new TokenBucket({ capacity: 4, windowMs: 4000, clock: () => 0 });
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntilToken(300)).toBe(bucket.timeUntil(1, 300));
        });
    });

    describe('acquire', () => {
        let clock: ReturnType<typeof makeClock>;

        beforeEach(() => {
            jest.useFakeTimers();
            clock = makeClock(0);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        async function advanceBoth(ms: number): Promise<void> {
            clock.advance(ms);
            await jest.advanceTimersByTimeAsync(ms);
        }

        it('resolves immediately when a token is already available', async () => {
            const bucket = new TokenBucket({ capacity: 1, windowMs: 1000, clock: clock.now });
            await expect(bucket.acquire(5000)).resolves.toBeUndefined();
        });

        it('waits exactly until the next token is available, then resolves', async () => {
            const bucket = new TokenBucket({ capacity: 1, windowMs: 1000, clock: clock.now });
            await bucket.acquire(5000);

            const pending = bucket.acquire(5000);
            let settled = false;
            pending.then(() => (settled = true));

            await advanceBoth(500);
            expect(settled).toBe(false);

            await advanceBoth(500);
            await expect(pending).resolves.toBeUndefined();
        });

        it('rejects with TokenBucketTimeoutError once timeoutMs elapses with no token', async () => {
            const bucket = new TokenBucket({ capacity: 1, windowMs: 1_000_000, clock: clock.now });
            await bucket.acquire(5000);

            const pending = bucket.acquire(50);
            const expectation = expect(pending).rejects.toBeInstanceOf(TokenBucketTimeoutError);

            await advanceBoth(50);

            await expectation;
        });

        it('honors the default 30000ms timeout when none is given', async () => {
            const bucket = new TokenBucket({ capacity: 1, windowMs: 1_000_000, clock: clock.now });
            await bucket.acquire();

            const pending = bucket.acquire();
            const expectation = expect(pending).rejects.toBeInstanceOf(TokenBucketTimeoutError);

            await advanceBoth(30_000);

            await expectation;
        });

        it.each([-1, NaN, -Infinity])('rejects with TypeError for an invalid timeoutMs: %p', async (timeoutMs) => {
            const bucket = new TokenBucket({ capacity: 1, windowMs: 1000, clock: clock.now });
            await expect(bucket.acquire(timeoutMs)).rejects.toThrow(TypeError);
        });

        it('serves concurrent callers one at a time, in first-come-first-served order', async () => {
            const bucket = new TokenBucket({ capacity: 2, windowMs: 2000, clock: clock.now });
            await bucket.acquire(5000);
            await bucket.acquire(5000);

            const resolutionOrder: number[] = [];
            const p1 = bucket.acquire(5000).then(() => resolutionOrder.push(1));
            const p2 = bucket.acquire(5000).then(() => resolutionOrder.push(2));
            const p3 = bucket.acquire(5000).then(() => resolutionOrder.push(3));

            await advanceBoth(1000);
            expect(resolutionOrder).toEqual([1]);

            await advanceBoth(1000);
            expect(resolutionOrder).toEqual([1, 2]);

            await advanceBoth(1000);
            expect(resolutionOrder).toEqual([1, 2, 3]);

            await Promise.all([p1, p2, p3]);
        });
    });

    describe('documented behavior (capacity=40, windowMs=60000)', () => {
        it('matches the JSDoc example: 30 instant requests leave 10 tokens, refill takes ~1500ms', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket({ capacity: 40, windowMs: 60_000, clock: clock.now });

            for (let i = 0; i < 30; i++) {
                expect(bucket.tryAcquire(clock.now())).toBe(true);
            }
            expect(bucket.peekTokens()).toBe(10);

            for (let i = 0; i < 10; i++) {
                expect(bucket.tryAcquire(clock.now())).toBe(true);
            }
            expect(bucket.tryAcquire(clock.now())).toBe(false);

            expect(bucket.timeUntilToken(clock.now())).toBe(1500);
        });
    });
});
