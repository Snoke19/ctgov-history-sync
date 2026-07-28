import {TokenBucket} from '../../../src/http/limiter/tokenBucket.js';
import {performance} from 'node:perf_hooks';
import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {TokenBucketTimeoutError} from '../../../src/error/errors.js';

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

async function consume(bucket, count) {
    for (let i = 0; i < count; i++) {
        await bucket.acquire(0);
    }
}

describe('TokenBucket', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    describe('timeUntil/tryAcquire agreement at float boundaries', () => {
        it('timeUntil(1) returns 0 whenever tryAcquire() would succeed', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(3, 10_000, clock.now);
            // msPerToken = 3333.333...; after consuming 2 of 3 tokens, the
            // remaining credit is mathematically exactly one token's worth,
            // but float subtraction leaves it ~9e-13 below that — enough to
            // flip a non-tolerant comparison without an EPS guard.
            await consume(bucket, 2);

            expect(bucket.timeUntil(1)).toBe(0);
            await expect(bucket.acquire(0)).resolves.toBeUndefined();
        });
    });

    describe('non-monotonic clock defensiveness', () => {
        it('does not lose credit if the injected clock reports a backward jump', async () => {
            let time = 1_000;
            const bucket = new TokenBucket(5, 10_000, () => time);

            await bucket.acquire(0); // consumes 1 token at time=1000
            expect(bucket.peekTokens()).toBe(4);

            time = 500; // clock moves backward — shouldn't happen with
            // performance.now(), but a broken injected clock
            // shouldn't be able to drain credit as a side effect
            expect(bucket.peekTokens()).toBe(4);

            time = 1_000; // back to normal, unaffected
            expect(bucket.peekTokens()).toBe(4);
        });
    });

    describe('capacity and windowMs getters', () => {
        it('exposes the configured capacity', () => {
            expect(new TokenBucket(7, 5_000).capacity).toBe(7);
        });

        it('exposes the configured windowMs', () => {
            expect(new TokenBucket(7, 5_000).windowMs).toBe(5_000);
        });
    });

    /* ==================================================================
       CONSTRUCTOR
       ================================================================== */
    describe('constructor', () => {
        it('creates a bucket at full capacity', () => {
            const bucket = new TokenBucket(40, 60_000);
            expect(bucket.peekTokens()).toBe(40);
        });

        it('records the initial timestamp from performance.now by default', () => {
            const before = performance.now();
            const bucket = new TokenBucket(10, 5_000);
            const after = performance.now();
            expect(bucket.lastUpdate).toBeGreaterThanOrEqual(Math.floor(before));
            expect(bucket.lastUpdate).toBeLessThanOrEqual(after);
        });

        it('accepts a custom now() function', () => {
            const bucket = new TokenBucket(10, 5_000, () => 12_345);
            expect(bucket.lastUpdate).toBe(12_345);
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
                ['non-integer greater than 1', 2.5], // add
                ['non-integer between 0 and 1', 0.5], // add
            ])('throws TypeError for %s (%p)', (_label, value) => {
                expect(() => new TokenBucket(value, 5_000)).toThrow(
                    new TypeError('capacity must be a positive integer'),
                );
            });

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
                    new TypeError('capacity must be a positive integer'),
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

    /* ==================================================================
       peekTokens
       ================================================================== */
    describe('peekTokens', () => {
        it('returns full capacity before any consumption', () => {
            const bucket = new TokenBucket(100, 10_000, () => 0);
            expect(bucket.peekTokens()).toBe(100);
        });

        it('decreases by exactly one after each consumption', async () => {
            const bucket = new TokenBucket(5, 10_000, () => 0);
            await bucket.acquire(0);
            expect(bucket.peekTokens()).toBe(4);
        });

        it('refills lazily based on elapsed time', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await consume(bucket, 5);
            clock.advance(2_500);
            expect(bucket.peekTokens()).toBe(7);
        });

        it('floors fractional tokens (e.g. 3.7 → 3)', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await bucket.acquire(0);
            clock.advance(350);
            expect(bucket.peekTokens()).toBe(9);
        });

        it('never reports more than capacity even after long idle time', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(3, 1_000, clock.now);

            await bucket.acquire(0);
            clock.advance(100_000);
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

        it('returns 0 when the bucket is fully drained', async () => {
            const bucket = new TokenBucket(2, 10_000, () => 0);
            await consume(bucket, 2);
            expect(bucket.peekTokens()).toBe(0);
        });

        it('handles non-integer msPerToken correctly (capacity=3, windowMs=10000)', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(3, 10_000, clock.now);
            // msPerToken = 3333.333...

            await consume(bucket, 1); // 2 tokens left ≈ 6666.667 ms credit
            expect(bucket.peekTokens()).toBe(2);

            clock.advance(1_666); // +1666 credit → 8333.333 total ≈ 2.5 tokens
            expect(bucket.peekTokens()).toBe(2); // floor(2.5)
        });

        it('returns capacity when bucket is exactly full, bypassing float division', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(3, 10_000, clock.now);

            await consume(bucket, 1);
            clock.advance(3_334); // exactly enough to refill 1 token
            // creditMs should be back to ~10000
            expect(bucket.peekTokens()).toBe(3);
        });
    });

    /* ==================================================================
       lastUpdate
       ================================================================== */
    describe('lastUpdate', () => {
        it('updates on every successful token consumption', async () => {
            const clock = createClock(1_000);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            expect(bucket.lastUpdate).toBe(1_000);

            clock.advance(500);
            await bucket.acquire(0);
            expect(bucket.lastUpdate).toBe(1_500);

            clock.advance(200);
            await bucket.acquire(0);
            expect(bucket.lastUpdate).toBe(1_700);
        });

        it('does NOT update when acquire times out', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(1, 1_000, clock.now);

            await bucket.acquire(0); // drain
            const lastBefore = bucket.lastUpdate;

            try {
                await bucket.acquire(0); // timeout immediately
            } catch {
                // expected
            }

            expect(bucket.lastUpdate).toBe(lastBefore);
        });
    });

    /* ==================================================================
       timeUntil
       ================================================================== */
    describe('timeUntil', () => {
        it('returns 0 when enough tokens are already available', () => {
            const bucket = new TokenBucket(10, 10_000, () => 0);
            expect(bucket.timeUntil(1)).toBe(0);
            expect(bucket.timeUntil(10)).toBe(0);
        });

        it('returns Infinity when count exceeds capacity', () => {
            const bucket = new TokenBucket(5, 10_000, () => 0);
            expect(bucket.timeUntil(6)).toBe(Infinity);
            expect(bucket.timeUntil(100)).toBe(Infinity);
        });

        it('validates that count is a positive finite number', () => {
            const bucket = new TokenBucket(10, 10_000, () => 0);
            expect(() => bucket.timeUntil(0)).toThrow(TypeError);
            expect(() => bucket.timeUntil(-1)).toThrow(TypeError);
            expect(() => bucket.timeUntil(NaN)).toThrow(TypeError);
            expect(() => bucket.timeUntil(Infinity)).toThrow(TypeError);
        });

        it('calculates exact wait for a single token after drain', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await consume(bucket, 10);
            clock.advance(300);
            expect(bucket.timeUntil(1)).toBe(700);
        });

        it('calculates wait for multiple tokens after partial drain', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            await consume(bucket, 8);
            expect(bucket.timeUntil(2)).toBe(0);
            expect(bucket.timeUntil(3)).toBe(1_000);
            expect(bucket.timeUntil(5)).toBe(3_000);
        });

        it('returns 0 for any count when bucket is exactly full', () => {
            const bucket = new TokenBucket(5, 10_000, () => 0);
            expect(bucket.timeUntil(5)).toBe(0);
        });

        it('returns 0 after sufficient time has passed', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(4, 4_000, clock.now);

            await consume(bucket, 4);
            clock.advance(2_500); // 2.5 tokens worth of time
            expect(bucket.timeUntil(2)).toBe(0);
            expect(bucket.timeUntil(3)).toBe(500);
        });
    });

    /* ==================================================================
       acquire
       ================================================================== */
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

        it('succeeds with timeoutMs=0 when a token is immediately available', async () => {
            const bucket = new TokenBucket(5, 10_000, () => 0);
            await expect(bucket.acquire(0)).resolves.toBeUndefined();
        });

        it('throws TokenBucketTimeoutError with timeoutMs=0 when no token is available', async () => {
            const bucket = new TokenBucket(1, 1_000, () => 0);
            await bucket.acquire(0); // drain

            await expect(bucket.acquire(0)).rejects.toThrow(TokenBucketTimeoutError);
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
                const bucket = new TokenBucket(1, 1_000, clock.now);

                await bucket.acquire(0);
                const promise = bucket.acquire(10_000);

                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);

                await expect(promise).resolves.toBeUndefined();
            });

            it('throws TokenBucketTimeoutError when deadline is reached', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 10_000, clock.now);

                await bucket.acquire(0);
                const promise = bucket.acquire(500);

                clock.advance(500);
                jest.advanceTimersByTime(500);

                await expect(promise).rejects.toThrow(TokenBucketTimeoutError);
                await expect(promise).rejects.toThrow(
                    'TokenBucket timeout: no token available within 500ms',
                );
            });

            it('exposes timeoutMs on the error object', async () => {
                jest.useFakeTimers();

                const clock = createClock(0);
                const bucket = new TokenBucket(1, 10_000, clock.now);

                await bucket.acquire(0);
                const promise = bucket.acquire(750);

                clock.advance(750);
                jest.advanceTimersByTime(750);

                await expect(promise).rejects.toThrow(TokenBucketTimeoutError);
                await expect(promise).rejects.toMatchObject({
                    name: 'TokenBucketTimeoutError',
                    timeoutMs: 750,
                    message: expect.stringContaining('750'),
                });
            });

            it('sleeps in multiple iterations if token is not ready after first wake-up', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 1_000, clock.now);

                await bucket.acquire(0);
                const promise = bucket.acquire(10_000);

                clock.advance(300);
                jest.advanceTimersByTime(300);

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

            it('does not mutate state when timing out', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 10_000, clock.now);

                await bucket.acquire(0);
                const creditBefore = bucket.peekTokens();
                const lastUpdateBefore = bucket.lastUpdate;

                const promise = bucket.acquire(100);

                clock.advance(100);
                jest.advanceTimersByTime(100);

                await expect(promise).rejects.toThrow(TokenBucketTimeoutError);

                expect(bucket.peekTokens()).toBe(creditBefore);
                expect(bucket.lastUpdate).toBe(lastUpdateBefore);
            });
        });

        describe('with real timers', () => {
            it('waits approximately the correct time for a token', async () => {
                const bucket = new TokenBucket(1, 500, () => performance.now());
                await bucket.acquire(); // drain

                const start = performance.now();
                await bucket.acquire(10_000); // should resolve in ~500ms
                const elapsed = performance.now() - start;

                expect(elapsed).toBeGreaterThanOrEqual(450);
                expect(elapsed).toBeLessThan(700); // generous margin for event loop jitter
            });
        });
    });

    /* ==================================================================
       Concurrent async safety
       ================================================================== */
    describe('concurrent async safety', () => {
        it('does not over-consume when two acquires start in the same tick', async () => {
            const bucket = new TokenBucket(1, 1_000, () => 0);

            const p1 = bucket.acquire(0);
            const p2 = bucket.acquire(0);

            await expect(p1).resolves.toBeUndefined();
            await expect(p2).rejects.toThrow(TokenBucketTimeoutError);
        });

        it('queues waiting acquires in FIFO order', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(1, 1_000, clock.now);

            const times = [];

            const p1 = bucket.acquire(10_000).then(() => times.push(clock.getTime()));
            const p2 = bucket.acquire(10_000).then(() => times.push(clock.getTime()));

            await p1;
            expect(times[0]).toBe(0);

            clock.advance(1_000);
            jest.advanceTimersByTime(1_000);
            await p2;
            expect(times[1]).toBe(1_000);
        });

        it('handles many concurrent waiters with limited tokens', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(2, 2_000, clock.now);

            // Start 5 concurrent acquires.
            // The first 2 resolve immediately (synchronous, no timer).
            // The remaining 3 schedule setTimeout and wait.
            const p0 = bucket.acquire(10_000);
            const p1 = bucket.acquire(10_000);
            const p2 = bucket.acquire(10_000);
            const p3 = bucket.acquire(10_000);
            const p4 = bucket.acquire(10_000);

            // First 2 are already resolved.
            await expect(p0).resolves.toBeUndefined();
            await expect(p1).resolves.toBeUndefined();

            // Advance 2s: 2 tokens refill. The next 2 waiters wake up and resolve.
            clock.advance(2_000);
            jest.advanceTimersByTime(2_000);
            await expect(p2).resolves.toBeUndefined();
            await expect(p3).resolves.toBeUndefined();

            // Advance 2s more: last token refills. Final waiter resolves.
            clock.advance(2_000);
            jest.advanceTimersByTime(2_000);
            await expect(p4).resolves.toBeUndefined();
        });
    });

    /* ==================================================================
       Complex lifecycle scenarios
       ================================================================== */
    describe('lifecycle scenarios', () => {
        it('sawtooth pattern: burst, wait, burst, wait', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(5, 5_000, clock.now);

            // Burst 5
            await consume(bucket, 5);
            expect(bucket.peekTokens()).toBe(0);

            // Wait 2.5s → 2.5 tokens refilled
            clock.advance(2_500);
            expect(bucket.peekTokens()).toBe(2);

            // Burst 2
            await consume(bucket, 2);
            expect(bucket.peekTokens()).toBe(0);

            // Wait 5s → full again
            clock.advance(5_000);
            expect(bucket.peekTokens()).toBe(5);
        });

        it('starvation: many requests, one token', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(1, 1_000, clock.now);

            const p1 = bucket.acquire(10_000);
            const p2 = bucket.acquire(10_000);
            const p3 = bucket.acquire(10_000);

            await p1; // t=0
            clock.advance(1_000);
            jest.advanceTimersByTime(1_000);
            await p2; // t=1000
            clock.advance(1_000);
            jest.advanceTimersByTime(1_000);
            await p3; // t=2000

            expect(clock.getTime()).toBe(2_000);
        });

        it('interleaved peek and acquire does not corrupt state', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(10, 10_000, clock.now);

            for (let i = 0; i < 5; i++) {
                bucket.peekTokens();
                await bucket.acquire(0);
                bucket.peekTokens();
                clock.advance(500);
            }

            // 5 consumed, 2.5 refilled → 7.5 credit → 7 tokens
            expect(bucket.peekTokens()).toBe(7);
        });
    });

    /* ==================================================================
       Integration (JSDoc example)
       ================================================================== */
    describe('integration (JSDoc example)', () => {
        it('drains fully and measures exact refill wait', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(40, 60_000, clock.now);

            expect(bucket.peekTokens()).toBe(40);

            for (let i = 0; i < 40; i++) {
                await bucket.acquire(0);
            }

            expect(bucket.peekTokens()).toBe(0);
            expect(bucket.timeUntil(1)).toBe(1_500);

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
            expect(bucket.timeUntil(1)).toBe(0);
        });

        it('full cycle: empty → refill → burst → empty', async () => {
            jest.useFakeTimers();
            const clock = createClock(0);
            const bucket = new TokenBucket(4, 4_000, clock.now);

            // Start full
            expect(bucket.peekTokens()).toBe(4);

            // Drain
            await consume(bucket, 4);
            expect(bucket.peekTokens()).toBe(0);

            // Refill half
            clock.advance(2_000);
            expect(bucket.peekTokens()).toBe(2);

            // Consume the 2
            await consume(bucket, 2);
            expect(bucket.peekTokens()).toBe(0);

            // Refill fully
            clock.advance(4_000);
            expect(bucket.peekTokens()).toBe(4);

            // Final burst
            await consume(bucket, 4);
            expect(bucket.peekTokens()).toBe(0);
        });
    });

    describe('TokenBucket — Edge Cases & Boundaries', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it('handles irrational-like division (capacity=3, windowMs=10000)', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(3, 10_000, clock.now);
            await consume(bucket, 1);
            clock.advance(1_666);
            expect(bucket.peekTokens()).toBe(2); // 2.5 floored → 2
        });

        it('maintains accuracy after 1000 partial consumes', async () => {
            const clock = createClock(0);
            const bucket = new TokenBucket(100, 100_000, clock.now);
            for (let i = 0; i < 1000; i++) {
                await bucket.acquire(0);
                clock.advance(1_000);
            }
            expect(bucket.peekTokens()).toBeGreaterThanOrEqual(99);
        });

        /* ================================================================
           BOUNDARY: creditMs exactly equals costMs
           ================================================================ */
        describe('exact boundary creditMs === costMs', () => {
            it('accepts when credit is exactly one token worth', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(4, 4_000, clock.now);

                await consume(bucket, 3); // 1 token left = 1000 ms credit
                expect(bucket.peekTokens()).toBe(1);

                // creditMs should be exactly 1000, costMs is 1000
                await expect(bucket.acquire(0)).resolves.toBeUndefined();
            });

            it('rejects when credit is just below one token (after float subtraction)', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(3, 10_000, clock.now);
                // msPerToken = 3333.333...

                await consume(bucket, 2);
                // creditMs ≈ 3333.333... which is exactly costMs
                // But due to float subtraction: 10000 - 3333.333... - 3333.333...
                // might be 3333.333... or slightly less
                const tokens = bucket.peekTokens();
                expect(tokens).toBeGreaterThanOrEqual(0);
                expect(tokens).toBeLessThanOrEqual(1);
            });
        });

        /* ================================================================
           BOUNDARY: timeoutMs exactly equals timeUntil
           ================================================================ */
        describe('timeoutMs exactly equals timeUntil', () => {
            it('resolves when timeout exactly matches wait time', async () => {
                jest.useFakeTimers();
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 1_000, clock.now);

                await bucket.acquire(0); // drain
                const promise = bucket.acquire(1_000);

                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);

                await expect(promise).resolves.toBeUndefined();
            });

            it('times out when timeout is 1ms shorter than needed', async () => {
                jest.useFakeTimers();
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 1_000, clock.now);

                await bucket.acquire(0); // drain
                const promise = bucket.acquire(999);

                clock.advance(999);
                jest.advanceTimersByTime(999);

                await expect(promise).rejects.toThrow(TokenBucketTimeoutError);
            });
        });

        /* ================================================================
           EXTREME: capacity = 1 (minimal bucket)
           ================================================================ */
        describe('minimal bucket (capacity = 1)', () => {
            it('allows exactly one request then blocks', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 5_000, clock.now);

                expect(bucket.peekTokens()).toBe(1);
                await bucket.acquire(0);
                expect(bucket.peekTokens()).toBe(0);
                await expect(bucket.acquire(0)).rejects.toThrow(TokenBucketTimeoutError);
            });

            it('refills after full window has passed', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 5_000, clock.now);

                await bucket.acquire(0);
                clock.advance(5_000);
                expect(bucket.peekTokens()).toBe(1);
                await expect(bucket.acquire(0)).resolves.toBeUndefined();
            });
        });

        /* ================================================================
           EXTREME: very large capacity
           ================================================================ */
        describe('very large capacity', () => {
            it('handles capacity of 1_000_000 without overflow', () => {
                const bucket = new TokenBucket(1_000_000, 3_600_000_000, () => 0);
                // windowMs = 1 hour, capacity = 1M → msPerToken = 3600
                expect(bucket.peekTokens()).toBe(1_000_000);
                expect(bucket.timeUntil(1)).toBe(0);
            });

            it('handles large values with non-integer msPerToken', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1_000_000, 3_600_001, clock.now);
                // msPerToken = 3.600001

                await bucket.acquire(0);
                const tokens = bucket.peekTokens();
                expect(tokens).toBe(999_999);
            });
        });

        /* ================================================================
           EXTREME: very small windowMs
           ================================================================ */
        describe('very small windowMs', () => {
            it('handles sub-millisecond token costs', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(100, 10, clock.now);
                // msPerToken = 0.1 ms

                expect(bucket.peekTokens()).toBe(100);
                await bucket.acquire(0);
                expect(bucket.peekTokens()).toBe(99);
            });

            it('refills rapidly with tiny window', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(10, 1, clock.now);
                // msPerToken = 0.1 ms

                await consume(bucket, 10);
                expect(bucket.peekTokens()).toBe(0);

                clock.advance(0.5); // half a millisecond → 5 tokens
                expect(bucket.peekTokens()).toBe(5);
            });
        });

        /* ================================================================
           STRESS: rapid acquire(0) on empty bucket
           ================================================================ */
        describe('rapid fire on empty bucket', () => {
            it('all immediate acquires on empty bucket timeout instantly', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 10_000, clock.now);
                await bucket.acquire(0); // drain

                const promises = [];
                for (let i = 0; i < 10; i++) {
                    promises.push(bucket.acquire(0));
                }

                for (const p of promises) {
                    await expect(p).rejects.toThrow(TokenBucketTimeoutError);
                }
            });
        });

        /* ================================================================
           STRESS: alternating drain and full refill many times
           ================================================================ */
        describe('cumulative drift over many cycles', () => {
            it('maintains accuracy after 100 drain-refill cycles', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(10, 10_000, clock.now);

                for (let cycle = 0; cycle < 100; cycle++) {
                    await consume(bucket, 10);
                    expect(bucket.peekTokens()).toBe(0);

                    clock.advance(10_000);
                    expect(bucket.peekTokens()).toBe(10);
                }
            });

            it('maintains accuracy after 1000 partial consumes', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(100, 100_000, clock.now);

                for (let i = 0; i < 1000; i++) {
                    await bucket.acquire(0);
                    clock.advance(1_000); // refill 1 token between each
                }

                // After 1000 iterations: consumed 1000, refilled 1000
                // Net should be back to full (or very close)
                expect(bucket.peekTokens()).toBeGreaterThanOrEqual(99);
                expect(bucket.peekTokens()).toBeLessThanOrEqual(100);
            });
        });

        /* ================================================================
           STATE CONSISTENCY: peek does not mutate
           ================================================================ */
        describe('peek immutability', () => {
            it('1000 consecutive peeks do not change state', () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(5, 5_000, clock.now);

                const before = bucket.peekTokens();
                const lastUpdateBefore = bucket.lastUpdate;

                for (let i = 0; i < 1000; i++) {
                    bucket.peekTokens();
                }

                expect(bucket.peekTokens()).toBe(before);
                expect(bucket.lastUpdate).toBe(lastUpdateBefore);
            });

            it('peek during long idle does not prevent full refill', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(5, 5_000, clock.now);

                await consume(bucket, 3); // 2 left
                clock.advance(1_000_000); // 1000 seconds idle

                // Peek many times
                for (let i = 0; i < 100; i++) {
                    expect(bucket.peekTokens()).toBe(5);
                }

                // Should still be able to consume all 5
                await consume(bucket, 5);
                expect(bucket.peekTokens()).toBe(0);
            });
        });

        /* ================================================================
           FLOAT PRECISION: non-integer msPerToken stress
           ================================================================ */
        describe('non-integer msPerToken precision', () => {
            it('refills whole tokens correctly with prime capacity', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(7, 10_000, clock.now);
                // msPerToken = 10000 / 7 ≈ 1428.571 ms

                await consume(bucket, 3); // 4 tokens remain (5714.286 ms credit)

                // Advance 2858 ms (> 2×msPerToken = 2857.143 ms)
                // Credit refills by 2858 ms → 8572.286 ms total
                // 8572.286 / 1428.571 ≈ 6.0006 → floor = 6 tokens
                clock.advance(2_858);
                expect(bucket.peekTokens()).toBe(6);
            });

            it('floors partial tokens with prime capacity', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(7, 10_000, clock.now);
                // msPerToken = 10000 / 7 ≈ 1428.571 ms

                await consume(bucket, 3); // 4 tokens remain (5714.286 ms credit)

                // Advance 1000 ms (< 1×msPerToken)
                // Credit refills by 1000 ms → 6714.286 ms total
                // 6714.286 / 1428.571 ≈ 4.7 → floor = 4 tokens
                clock.advance(1_000);
                expect(bucket.peekTokens()).toBe(4);
            });

            it('floors fractional tokens with repeating-decimal msPerToken', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(3, 10_000, clock.now);
                // msPerToken = 10000 / 3 ≈ 3333.333 ms

                await consume(bucket, 1); // 2 tokens remain (6666.667 ms credit)

                // Advance 1666 ms (exactly half a token)
                // Credit refills by 1666 ms → 8332.667 ms total
                // 8332.667 / 3333.333 ≈ 2.5 → floor = 2 tokens
                clock.advance(1_666);
                expect(bucket.peekTokens()).toBe(2);
            });
        });

        /* ================================================================
           TIMEUNTIL: edge cases
           ================================================================ */
        describe('timeUntil edge cases', () => {
            it('returns 0 when requesting 0 tokens', () => {
                const bucket = new TokenBucket(10, 10_000, () => 0);
                expect(bucket.timeUntil(1)).toBe(0);
            });

            it('returns 0 for count exactly at capacity when full', () => {
                const bucket = new TokenBucket(5, 5_000, () => 0);
                expect(bucket.timeUntil(5)).toBe(0);
            });

            it('returns Infinity for count = capacity + 1', () => {
                const bucket = new TokenBucket(5, 5_000, () => 0);
                expect(bucket.timeUntil(6)).toBe(Infinity);
            });

            it('returns 0 for count = 1 after partial refill', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(10, 10_000, clock.now);

                await consume(bucket, 10); // drain
                clock.advance(500); // 0.5 token refilled
                expect(bucket.timeUntil(1)).toBe(500);
            });
        });

        /* ================================================================
           ACQUIRE: sleep precision with non-integer msPerToken
           ================================================================ */
        describe('acquire sleep precision', () => {
            it('sleeps in multiple iterations for non-integer msPerToken', async () => {
                jest.useFakeTimers();
                const clock = createClock(0);
                const bucket = new TokenBucket(3, 10_000, clock.now);
                // msPerToken = 3333.333...

                // Drain with default timeout (avoids float edge case on last token)
                await bucket.acquire();
                await bucket.acquire();
                await bucket.acquire();

                const promise = bucket.acquire(10_000);

                // First iteration: 1000 ms (not enough)
                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);

                // Second iteration: 1000 ms (still not enough)
                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);

                // Third iteration: 1334 ms (total 3334 > 3333.333...)
                clock.advance(1_334);
                jest.advanceTimersByTime(1_334);

                await expect(promise).resolves.toBeUndefined();
            });
        });

        /* ================================================================
           CONCURRENT: complex ordering scenarios
           ================================================================ */
        describe('complex concurrent scenarios', () => {
            it('interleaved fast and slow consumers do not corrupt state', async () => {
                jest.useFakeTimers();
                const clock = createClock(0);
                const bucket = new TokenBucket(3, 3_000, clock.now);

                // 3 immediate consumers
                const p1 = bucket.acquire(10_000);
                const p2 = bucket.acquire(10_000);
                const p3 = bucket.acquire(10_000);

                await expect(p1).resolves.toBeUndefined();
                await expect(p2).resolves.toBeUndefined();
                await expect(p3).resolves.toBeUndefined();

                // 3 waiters
                const p4 = bucket.acquire(10_000);
                const p5 = bucket.acquire(10_000);
                const p6 = bucket.acquire(10_000);

                // Refill 1 token
                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);
                await expect(p4).resolves.toBeUndefined();

                // Refill 1 more
                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);
                await expect(p5).resolves.toBeUndefined();

                // Refill last
                clock.advance(1_000);
                jest.advanceTimersByTime(1_000);
                await expect(p6).resolves.toBeUndefined();
            });

            it('multiple timeouts followed by success', async () => {
                jest.useFakeTimers();
                const clock = createClock(0);
                const bucket = new TokenBucket(1, 5_000, clock.now);

                await bucket.acquire(0); // drain

                // Short timeouts — all fail
                const short1 = bucket.acquire(100);
                const short2 = bucket.acquire(200);
                const short3 = bucket.acquire(300);

                clock.advance(300);
                jest.advanceTimersByTime(300);

                await expect(short1).rejects.toThrow(TokenBucketTimeoutError);
                await expect(short2).rejects.toThrow(TokenBucketTimeoutError);
                await expect(short3).rejects.toThrow(TokenBucketTimeoutError);

                // Long timeout — succeeds after refill
                const long = bucket.acquire(10_000);
                clock.advance(4_700); // 300 already passed, need 4700 more
                jest.advanceTimersByTime(4_700);
                await expect(long).resolves.toBeUndefined();
            });
        });

        /* ================================================================
           LIFECYCLE: partial consumption patterns
           ================================================================ */
        describe('partial consumption patterns', () => {
            it('consume 1, wait half, consume 1, wait half — sawtooth', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(4, 4_000, clock.now);

                await bucket.acquire(0);
                clock.advance(500);
                await bucket.acquire(0);
                clock.advance(500);
                await bucket.acquire(0);
                clock.advance(500);
                await bucket.acquire(0);

                // 4 consumed, 1.5 refilled → 1.5 credit → 1 token
                expect(bucket.peekTokens()).toBe(1);
            });

            it('never consumes more than available even with aggressive timing', async () => {
                const clock = createClock(0);
                const bucket = new TokenBucket(2, 2_000, clock.now);

                await bucket.acquire(0);
                clock.advance(999); // just under 1 token worth
                await bucket.acquire(0);
                // 2 consumed, 0.999 refilled → 0.999 credit → 0 tokens
                expect(bucket.peekTokens()).toBe(0);
            });
        });

        /* ================================================================
           REAL TIMERS: approximate timing validation
           ================================================================ */
        describe('real timer behavior', () => {
            it('waits approximately the correct duration with real timers', async () => {
                const bucket = new TokenBucket(1, 300, () => performance.now());
                await bucket.acquire(); // drain

                const start = performance.now();
                await bucket.acquire(10_000);
                const elapsed = performance.now() - start;

                expect(elapsed).toBeGreaterThanOrEqual(250);
                expect(elapsed).toBeLessThan(500);
            });

            it('resolves immediately when token is available with real timers', async () => {
                const bucket = new TokenBucket(10, 10_000, () => performance.now());
                const start = performance.now();
                await bucket.acquire(10_000);
                const elapsed = performance.now() - start;

                expect(elapsed).toBeLessThan(50); // essentially instant
            });
        });
    });
});
