import {performance} from 'node:perf_hooks';

/**
 * Token bucket rate limiter.
 *
 * Models a bucket that holds up to `capacity` tokens. Each token represents
 * one permitted request.
 *
 * Tokens refill smoothly over time at a rate of
 * `capacity / windowMs` tokens per millisecond.
 *
 * Instead of continuously updating the bucket, refills are computed lazily
 * whenever the bucket is queried. The implementation stores only the token
 * count and the timestamp of the last update, making refills O(1) without
 * background timers.
 *
 * Thread safety: Safe for concurrent async usage because Node.js runs on a
 * single event loop. All state mutations happen synchronously before the first
 * `await`, so there are no race conditions between concurrent `acquire()` calls.
 *
 * Example with capacity=40, windowMs=60000:
 *   - Starts full: 40 tokens available.
 *   - Each request consumes 1 token.
 *   - Refill rate: 1 token every 1500 ms.
 *   - After 30 requests, 10 tokens remain; next token in ~1.5 s.
 */
export class TokenBucket {
    #capacity;
    #windowMs;
    #lastRefill;
    #refillRate;
    #availableTokens;

    /**
     * @param {number} capacity - Maximum tokens the bucket can hold.
     * @param {number} windowMs - Time window over which `capacity` tokens
     *   are replenished, in milliseconds.
     */
    constructor(capacity, windowMs) {
        if (!Number.isFinite(capacity) || capacity <= 0) {
            throw new TypeError("capacity must be a positive finite number");
        }

        if (!Number.isFinite(windowMs) || windowMs <= 0) {
            throw new TypeError("windowMs must be a positive finite number");
        }

        this.#capacity = capacity;
        this.#availableTokens = capacity;
        this.#windowMs = windowMs;
        this.#refillRate = capacity / windowMs;
        this.#lastRefill = performance.now();
    }

    #available(now = performance.now()) {
        const elapsed = now - this.#lastRefill;

        return Math.min(
            this.#capacity,
            this.#availableTokens + elapsed * this.#refillRate,
        );
    }

    /**
     * Peek at the number of tokens currently available.
     *
     * This is a read-only snapshot: it computes how many tokens would be
     * available right now based on elapsed time since the last refill, but
     * does NOT mutate the bucket state. Use this for selection/sorting;
     * use `acquire()` to actually consume a token.
     *
     * @returns {number} Floored token count (e.g. 3.7 → 3).
     */
    peekTokens() {
        return Math.floor(this.#available());
    }

    /**
     * Timestamp of the last state update.
     *
     * Updated whenever a token is consumed. Combined with the stored token
     * count, it allows the bucket to lazily compute the current number of
     * available tokens without running a background refill task.
     *
     * @returns {number} Monotonic timestamp from `performance.now()`.
     */
    get lastRefill() {
        return this.#lastRefill;
    }

    /**
     * Returns the time (ms) until `count` tokens are available.
     *
     * @param {number} [count=1] - Required number of tokens.
     * @returns {number} Milliseconds until enough tokens exist.
     */
    timeUntil(count = 1) {
        const now = performance.now();
        const available = this.#available(now);

        if (available >= count) {
            return 0;
        }

        const tokensNeeded = count - available;
        return Math.ceil(tokensNeeded / this.#refillRate);
    }

    /**
     * Acquire one token, blocking until available or the timeout expires.
     *
     * Algorithm:
     *   1. Compute elapsed time since last refill.
     *   2. Add back proportional tokens (capped at capacity).
     *   3. If ≥1 token available: consume 1 and return immediately.
     *   4. Otherwise: sleep exactly until the next token is ready
     *      (not a fixed interval), then loop.
     *
     * The sleep duration is calculated precisely: if 0.3 tokens are needed
     * and the rate is 1 token per 1500 ms, it sleeps 450 ms — not 1500 ms.
     * This minimizes unnecessary waiting under high concurrency.
     *
     * @param {number} [timeoutMs=30000] - Maximum time to wait for a token.
     * @returns {Promise<void>} Resolves when a token is consumed.
     * @throws {Error} "TokenBucket timeout" if no token becomes available
     *   within `timeoutMs`.
     */
    async acquire(timeoutMs = 30000) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new TypeError("timeoutMs must be a non-negative finite number");
        }

        const deadline = performance.now() + timeoutMs;
        const refillRate = this.#refillRate;

        for (; ;) {
            const now = performance.now();
            const available = this.#available(now);

            if (available >= 1) {
                this.#availableTokens = available - 1;
                this.#lastRefill = now;
                return;
            }

            const tokensNeeded = 1 - available;

            const sleepMs = Math.min(
                Math.ceil(tokensNeeded / refillRate),
                deadline - now,
            );

            if (sleepMs <= 0) {
                throw new Error(
                    `TokenBucket timeout: no token available within ${timeoutMs}ms`,
                );
            }

            await new Promise(resolve => {
                setTimeout(resolve, sleepMs);
            });
        }
    }
}
