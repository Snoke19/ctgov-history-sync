import {TokenBucket} from '../src/http/tokenBucket.js';
import {performance} from 'node:perf_hooks';
import {afterEach, beforeEach, describe, expect, it, jest} from "@jest/globals";

function createClock(initialTime = 0) {
    let time = initialTime;
    return {
        now: () => time,
        advance: (ms) => {
            time += ms;
        },
        getTime: () => time,
    };
}

describe('TokenBucket', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('creates a bucket at full capacity', () => {
            const bucket = new TokenBucket(40, 60_000);
            expect(bucket.peekTokens()).toBe(40);
        });

        it('records the initial timestamp from performance.now by default', () => {
            const before = performance.now();
            const bucket = new TokenBucket(10, 5_000);
            const after = performance.now();
            expect(bucket.lastRefill).toBeGreaterThanOrEqual(Math.floor(before));
            expect(bucket.lastRefill).toBeLessThanOrEqual(after);
        });

        it('accepts a custom now() function', () => {
            const bucket = new TokenBucket(10, 5_000, () => 12_345);
            expect(bucket.lastRefill).toBe(12_345);
        });

        describe('capacity validation', () => {
            it.each([
                ['zero', 0],
                ['negative', -1],
                ['NaN', NaN],
                ['Infinity', Infinity],
                ['-Infinity', -Infinity],
                ['string', '10'],
                ['null', null],
                ['undefined', undefined],
            ])('throws TypeError for %s (%p)', (_label, value) => {
                expect(() => new TokenBucket(value, 5_000)).toThrow(
                    new TypeError('capacity must be a positive finite number'),
                );
            });
        });

        describe('windowMs validation', () => {
            it.each([
                ['zero', 0],
                ['negative', -1],
                ['NaN', NaN],
                ['Infinity', Infinity],
                ['string', '5000'],
                ['null', null],
            ])('throws TypeError for %s (%p)', (_label, value) => {
                expect(() => new TokenBucket(10, value)).toThrow(
                    new TypeError('windowMs must be a positive finite number'),
                );
            });
        });
    });

    describe('peekTokens', () => {
        it('returns full capacity before any consumption', () => {
            const bucket = new TokenBucket(100, 10_000, () => 0);
            expect(bucket.peekTokens()).toBe(100);
        });

        it('decreases after each consumption', async () => {
            const bucket = new TokenBucket(5, 10_000, () => 0);
            await bucket.acquire(0);
            expect(bucket.peekTokens()).toBe(4);
        });

        it('refills lazily based on elapsed time', async () => {
            const clock = createClock(0);
            // 10 tokens over 10 s => 1 token / 1 s
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await consume(bucket, 5);           // 5 left
            clock.advance(2_500);               // 2.5 tokens accrued
            expect(bucket.peekTokens()).toBe(7); // 5 + 2 (floored)
        });

        it('floors fractional tokens (e.g. 3.7 → 3)', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await bucket.acquire(0);            // 9 left
            clock.advance(350);                 // 0.35 token accrued
            expect(bucket.peekTokens()).toBe(9); // floor(9.35)
        });

        it('never reports more than capacity', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(3, 1_000, clock.now);

            await bucket.acquire(0);            // 2 left
            clock.advance(100_000);             // far more than needed
            expect(bucket.peekTokens()).toBe(3);
        });

        it('is read-only: repeated peeks return the same value', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(5, 10_000, clock.now);

            await bucket.acquire(0);
            clock.advance(5_000);

            const first = bucket.peekTokens();
            const second = bucket.peekTokens();
            expect(first).toBe(second);
        });
    });

    describe('lastRefill', () => {
        it('updates on every token consumption', async () => {
            const clock = createClock(1_000);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            expect(bucket.lastRefill).toBe(1_000);

            clock.advance(500);
            await bucket.acquire(0);
            expect(bucket.lastRefill).toBe(1_500);

            clock.advance(200);
            await bucket.acquire(0);
            expect(bucket.lastRefill).toBe(1_700);
        });
    });

    describe('timeUntil', () => {
        it('returns 0 when enough tokens are already available', () => {
            const bucket = new TokenBucket(10, 10_000, () => 0);
            expect(bucket.timeUntil(1)).toBe(0);
            expect(bucket.timeUntil(10)).toBe(0);
        });

        it('returns 0 for count = 0', () => {
            const bucket = new TokenBucket(10, 10_000, () => 0);
            expect(bucket.timeUntil(1)).toBe(0);
        });

        it('calculates exact wait for a single token', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now); // 1 token / 1 s

            await consume(bucket, 10);           // drain
            clock.advance(300);                  // 0.3 token accrued
            // need 0.7 more @ 0.001 token/ms  => 700 ms
            expect(bucket.timeUntil(1)).toBe(700);
        });

        it('calculates wait for multiple tokens', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await consume(bucket, 8);            // 2 left
            expect(bucket.timeUntil(2)).toBe(0);
            expect(bucket.timeUntil(3)).toBe(1_000);
            expect(bucket.timeUntil(5)).toBe(3_000);
        });
    });

    describe('acquire', () => {
        it('resolves immediately when a token is available', async () => {
            const bucket = new TokenBucket(1, 1_000, () => 0);
            await expect(bucket.acquire(10_000)).resolves.toBeUndefined();
        });

        it('does not schedule a timer when resolving immediately', async () => {
            const spy = jest.spyOn(global, 'setTimeout');
            const bucket = new TokenBucket(1, 1_000, () => 0);
            await bucket.acquire(10_000);
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('consumes exactly one token per call', async () => {
            const bucket = new TokenBucket(5, 10_000, () => 0);
            await bucket.acquire(0);
            expect(bucket.peekTokens()).toBe(4);
        });

        describe('timeoutMs validation', () => {
            it.each([
                ['negative', -1],
                ['NaN', NaN],
                ['Infinity', Infinity],
            ])('throws TypeError for %s timeout', async (_label, value) => {
                const bucket = new TokenBucket(1, 1_000, () => 0);
                await expect(bucket.acquire(value)).rejects.toThrow(
                    new TypeError('timeoutMs must be a non-negative finite number'),
                );
            });
        });

        describe('with fake timers', () => {
            beforeEach(() => {
                jest.useFakeTimers();
            });

            it('sleeps precisely until the next token is ready', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 1_000, clock.now); // 1 token / 1 s

                await bucket.acquire(0);            // drain
                const promise = bucket.acquire(10_000);

                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);

                await expect(promise).resolves.toBeUndefined();
            });

            it('throws TokenBucket timeout when deadline is reached', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 10_000, clock.now);

                await bucket.acquire(0);            // drain
                const promise = bucket.acquire(500);

                clock.advance(500);
                jest.advanceTimersByTime(500);

                await expect(promise).rejects.toThrow(
                    'TokenBucket timeout: no token available within 500ms',
                );
            });

            it('sleeps in multiple iterations if token is not ready after first wake-up', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 1_000, clock.now);

                await bucket.acquire(0);
                const promise = bucket.acquire(10_000);

                // First sleep: 300 ms (not enough)
                clock.advance(300);
                jest.advanceTimersByTime(300);

                // Second sleep: remaining 700 ms
                clock.advance(700);
                jest.advanceTimersByTime(700);

                await expect(promise).resolves.toBeUndefined();
            });

            it('resolves when token becomes available exactly at deadline', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 1_000, clock.now);

                await bucket.acquire(0);
                const promise = bucket.acquire(1_000);

                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);

                await expect(promise).resolves.toBeUndefined();
            });
        });
    });

    describe('concurrent async safety', () => {
        it('does not over-consume when two acquires start in the same tick', async () => {
            const bucket = new TokenBucket(1, 1_000, () => 0);

            // Both calls execute synchronously before any micro-task is processed.
            const p1 = bucket.acquire(0);
            const p2 = bucket.acquire(0);

            await expect(p1).resolves.toBeUndefined();
            await expect(p2).rejects.toThrow('TokenBucket timeout');
        });

        it('queues waiting acquires in FIFO order', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(1, 1_000, clock.now);

            const times = [];

            const p1 = bucket.acquire(10_000).then(() => times.push(clock.getTime()));
            const p2 = bucket.acquire(10_000).then(() => times.push(clock.getTime()));

            await p1;                           // resolves instantly at t=0
            expect(times[0]).toBe(0);

            clock.advance(1_000);
            jest.advanceTimersByTime(1_000);
            await p2;                           // resolves after refill at t=1000
            expect(times[1]).toBe(1_000);
        });
    });

    describe('integration (JSDoc example)', () => {
        it('drains fully and measures exact refill wait', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(40, 60_000, clock.now);

            // Starts full
            expect(bucket.peekTokens()).toBe(40);

            // Drain all 40 tokens instantly
            for (let i = 0; i < 40; i++) {
                await bucket.acquire(0);
            }

            // 0 tokens remain
            expect(bucket.peekTokens()).toBe(0);

            // Next token needs 1 500 ms (rate = 40 / 60 000 = 1 / 1 500)
            expect(bucket.timeUntil(1)).toBe(1_500);

            // After 1 500 ms one token has been replenished
            clock.advance(1_500);
            expect(bucket.peekTokens()).toBe(1);
        });

        it('30 instantaneous requests leave 10 tokens available immediately', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(40, 60_000, clock.now);

            for (let i = 0; i < 30; i++) {
                await bucket.acquire(0);
            }

            expect(bucket.peekTokens()).toBe(10);
            expect(bucket.timeUntil(1)).toBe(0);   // available now
        });
    });
});

async function consume(bucket, count) {
    for (let i = 0; i < count; i++) {
        await bucket.acquire(0);
    }
}
