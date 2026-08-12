import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigurationError, TokenBucketTimeoutError } from '../../../../src/error/errors.js';
import { TokenBucket } from '../../../../src/http/limiter/impl/tokenBucket.js';

/**
 * These tests treat TokenBucket as a black box: only the constructor and its
 * five public methods (tryAcquire, peekTokens, timeUntil, timeUntilToken,
 * acquire) are used. No private/internal fields are inspected.
 *
 * A controllable "virtual clock" is injected via the constructor's `now`
 * parameter so time can be advanced deterministically without real delays.
 * `tryAcquire` and `timeUntil` also accept an explicit `now` override — where
 * that's enough, the injected clock isn't even touched.
 */
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
            expect(() => new TokenBucket(5, 1000)).not.toThrow();
        });

        it('starts full: peekTokens() equals capacity right after construction', () => {
            const bucket = new TokenBucket(5, 1000);
            expect(bucket.peekTokens()).toBe(5);
        });

        it.each([0, -1, 1.5, NaN, Infinity])('rejects a non-positive-integer capacity: %p', (capacity) => {
            expect(() => new TokenBucket(capacity, 1000)).toThrow(ConfigurationError);
        });

        it.each([0, -1, NaN, Infinity])('rejects a non-positive-finite windowMs: %p', (windowMs) => {
            expect(() => new TokenBucket(5, windowMs)).toThrow(ConfigurationError);
        });

        it('accepts capacity = 1 (minimum valid value)', () => {
            expect(() => new TokenBucket(1, 1000)).not.toThrow();
        });
    });

    // -------------------------------------------------------------------
    // tryAcquire — driven entirely via the explicit `now` argument
    // -------------------------------------------------------------------
    describe('tryAcquire', () => {
        it('allows exactly `capacity` immediate acquisitions at the same instant', () => {
            const bucket = new TokenBucket(4, 4000, () => 0); // msPerToken = 1000ms
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(false); // 5th at the same instant must fail
        });

        it('grants a token again only once enough time has passed', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.tryAcquire(999)).toBe(false); // just short of 1 token's worth
            expect(bucket.tryAcquire(1000)).toBe(true); // exactly enough
        });

        it('does not grant two tokens for the same elapsed time window', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.tryAcquire(1000)).toBe(true);
            expect(bucket.tryAcquire(1000)).toBe(false); // no time passed since the last grant
        });

        it('accumulates partial credit correctly across multiple calls', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.tryAcquire(1000)).toBe(true); // credit: 0
            expect(bucket.tryAcquire(2500)).toBe(true); // +1500ms elapsed -> enough for 1 more
            expect(bucket.tryAcquire(2500)).toBe(false); // no further elapsed time
        });

        it('never grants more than `capacity` tokens even after a very long idle period', () => {
            const bucket = new TokenBucket(3, 3000, () => 0);
            expect(bucket.tryAcquire(1_000_000)).toBe(true);
            expect(bucket.tryAcquire(1_000_000)).toBe(true);
            expect(bucket.tryAcquire(1_000_000)).toBe(true);
            expect(bucket.tryAcquire(1_000_000)).toBe(false);
        });

        it('treats a `now` that goes backwards as zero elapsed time (no negative drain)', () => {
            const bucket = new TokenBucket(2, 2000, () => 0);
            expect(bucket.tryAcquire(1000)).toBe(true); // consumes 1 token at t=1000
            // A caller passes an earlier timestamp than the bucket's last update.
            expect(bucket.tryAcquire(500)).toBe(true); // must still behave sanely: 2nd token available
            expect(bucket.tryAcquire(500)).toBe(false); // and not "double dip" from going backwards
        });

        it('is not fooled by floating-point dust when msPerToken is not a whole number', () => {
            // capacity=3, windowMs=1000 -> msPerToken ≈ 333.333...
            const bucket = new TokenBucket(3, 1000, () => 0);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(true);
            expect(bucket.tryAcquire(0)).toBe(false); // must not slip through due to rounding
        });
    });

    // -------------------------------------------------------------------
    // peekTokens — needs the injected clock, since it takes no override param
    // -------------------------------------------------------------------
    describe('peekTokens', () => {
        it('is a pure read: calling it repeatedly does not consume tokens', () => {
            const bucket = new TokenBucket(3, 3000, () => 0);
            expect(bucket.peekTokens()).toBe(3);
            expect(bucket.peekTokens()).toBe(3);
            expect(bucket.peekTokens()).toBe(3);
            expect(bucket.tryAcquire(0)).toBe(true); // still consumable afterwards
        });

        it('reflects partial refill, floored down', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket(4, 4000, clock.now); // msPerToken = 1000ms
            bucket.tryAcquire(clock.now());

            clock.advance(500);
            expect(bucket.peekTokens()).toBe(3); // 3000ms credit + 500ms = 3500ms -> floor(3.5) = 3

            clock.advance(500); // total elapsed 1000ms
            expect(bucket.peekTokens()).toBe(4); // exactly full again
        });

        it('caps at capacity and does not overflow, even long after full', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket(4, 4000, clock.now);
            clock.advance(50_000); // far beyond windowMs
            expect(bucket.peekTokens()).toBe(4);
        });

        it('drops to 0 immediately after fully draining the bucket', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket(2, 2000, clock.now);
            bucket.tryAcquire(clock.now());
            bucket.tryAcquire(clock.now());
            expect(bucket.peekTokens()).toBe(0);
        });
    });

    // -------------------------------------------------------------------
    // timeUntil — driven via the explicit `now` argument
    // -------------------------------------------------------------------
    describe('timeUntil', () => {
        it('returns 0 for any count up to capacity while the bucket is full', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            expect(bucket.timeUntil(1, 0)).toBe(0);
            expect(bucket.timeUntil(4, 0)).toBe(0);
        });

        it('returns Infinity when count exceeds capacity — it can never be satisfied', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            expect(bucket.timeUntil(5, 0)).toBe(Infinity);
        });

        it('returns the exact wait time needed after the bucket is drained', () => {
            const bucket = new TokenBucket(4, 4000, () => 0); // msPerToken = 1000ms
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntil(1, 0)).toBe(1000);
            expect(bucket.timeUntil(1, 500)).toBe(500);
            expect(bucket.timeUntil(1, 1000)).toBe(0);
        });

        it('computes wait time proportionally for multi-token requests', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntil(2, 500)).toBe(1500); // needs 2000ms total, 500 already elapsed
        });

        it('never disagrees with tryAcquire about "available right now"', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntil(1, 1000)).toBe(0);
            expect(bucket.tryAcquire(1000)).toBe(true);
        });

        it.each([0, -1, NaN, Infinity])('rejects a non-positive-finite count: %p', (count) => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            expect(() => bucket.timeUntil(count, 0)).toThrow(TypeError);
        });
    });

    // -------------------------------------------------------------------
    // timeUntilToken
    // -------------------------------------------------------------------
    describe('timeUntilToken', () => {
        it('is equivalent to timeUntil(1, now)', () => {
            const bucket = new TokenBucket(4, 4000, () => 0);
            for (let i = 0; i < 4; i++) bucket.tryAcquire(0);

            expect(bucket.timeUntilToken(300)).toBe(bucket.timeUntil(1, 300));
        });
    });

    // -------------------------------------------------------------------
    // acquire — needs both the injected clock AND fake timers advanced in
    // lockstep, since acquire() schedules real setTimeout callbacks whose
    // delay is computed from the injected clock.
    // -------------------------------------------------------------------
    describe('acquire', () => {
        let clock: ReturnType<typeof makeClock>;

        beforeEach(() => {
            jest.useFakeTimers();
            clock = makeClock(0);
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        /** Advances the virtual clock and the fake timers together. */
        async function advanceBoth(ms: number): Promise<void> {
            clock.advance(ms);
            await jest.advanceTimersByTimeAsync(ms);
        }

        it('resolves immediately when a token is already available', async () => {
            const bucket = new TokenBucket(1, 1000, clock.now);
            await expect(bucket.acquire(5000)).resolves.toBeUndefined();
        });

        it('waits exactly until the next token is available, then resolves', async () => {
            const bucket = new TokenBucket(1, 1000, clock.now); // msPerToken = 1000ms
            await bucket.acquire(5000); // drains the only token

            const pending = bucket.acquire(5000);
            let settled = false;
            pending.then(() => (settled = true));

            await advanceBoth(500);
            expect(settled).toBe(false); // not yet — only half the refill time has passed

            await advanceBoth(500); // total 1000ms
            await expect(pending).resolves.toBeUndefined();
        });

        it('rejects with TokenBucketTimeoutError once timeoutMs elapses with no token', async () => {
            const bucket = new TokenBucket(1, 1_000_000, clock.now); // refill far too slow
            await bucket.acquire(5000); // drain the only token

            const pending = bucket.acquire(50);
            const expectation = expect(pending).rejects.toBeInstanceOf(TokenBucketTimeoutError);

            await advanceBoth(50);

            await expectation;
        });

        it('honors the default 30000ms timeout when none is given', async () => {
            const bucket = new TokenBucket(1, 1_000_000, clock.now);
            await bucket.acquire(); // drain the only token, using default timeout

            const pending = bucket.acquire(); // default timeout again
            const expectation = expect(pending).rejects.toBeInstanceOf(TokenBucketTimeoutError);

            await advanceBoth(30_000);

            await expectation;
        });

        it.each([-1, NaN, -Infinity])('rejects with TypeError for an invalid timeoutMs: %p', async (timeoutMs) => {
            const bucket = new TokenBucket(1, 1000, clock.now);
            await expect(bucket.acquire(timeoutMs)).rejects.toThrow(TypeError);
        });

        it('serves concurrent callers one at a time, in first-come-first-served order', async () => {
            // capacity=2, msPerToken=1000ms. Drain both tokens up front so all
            // three concurrent callers below start from an empty bucket.
            const bucket = new TokenBucket(2, 2000, clock.now);
            await bucket.acquire(5000);
            await bucket.acquire(5000);

            const resolutionOrder: number[] = [];
            const p1 = bucket.acquire(5000).then(() => resolutionOrder.push(1));
            const p2 = bucket.acquire(5000).then(() => resolutionOrder.push(2));
            const p3 = bucket.acquire(5000).then(() => resolutionOrder.push(3));

            await advanceBoth(1000);
            expect(resolutionOrder).toEqual([1]); // only one token has refilled so far

            await advanceBoth(1000);
            expect(resolutionOrder).toEqual([1, 2]);

            await advanceBoth(1000);
            expect(resolutionOrder).toEqual([1, 2, 3]);

            await Promise.all([p1, p2, p3]);
        });
    });

    // -------------------------------------------------------------------
    // Sanity check against the class's own documented example
    // -------------------------------------------------------------------
    describe('documented behavior (capacity=40, windowMs=60000)', () => {
        it('matches the JSDoc example: 30 instant requests leave 10 tokens, refill takes ~1500ms', () => {
            const clock = makeClock(0);
            const bucket = new TokenBucket(40, 60_000, clock.now);

            for (let i = 0; i < 30; i++) {
                expect(bucket.tryAcquire(clock.now())).toBe(true);
            }
            expect(bucket.peekTokens()).toBe(10);

            for (let i = 0; i < 10; i++) {
                expect(bucket.tryAcquire(clock.now())).toBe(true);
            }
            expect(bucket.tryAcquire(clock.now())).toBe(false); // fully drained

            expect(bucket.timeUntilToken(clock.now())).toBe(1500);
        });
    });
});
