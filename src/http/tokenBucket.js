import {performance} from 'node:perf_hooks';
import {TokenBucketTimeoutError} from '../error/errors.js';

const EPS = 1e-9;

/**
 * Token bucket rate limiter using credit-milliseconds.
 *
 * Internally the bucket stores "credit" in milliseconds, not fractional tokens.
 * A full bucket holds `windowMs` credit (equivalent to `capacity` tokens).
 * One token costs `msPerToken = windowMs / capacity` credit.
 *
 * Refill is lazy and O(1): credit increases by exactly `elapsed` milliseconds
 * since the last update, capped at `windowMs`. No background timer runs.
 *
 * Thread safety: Safe for concurrent async usage within a single Node.js
 * process because all state mutations in `acquire()` happen synchronously
 * before the first `await`.
 *
 * Example with capacity=40, windowMs=60000:
 *   - Starts full: 40 tokens available (60000 ms of credit).
 *   - Each request consumes 1 token (1500 ms of credit).
 *   - After 30 instantaneous requests, 10 tokens remain; the 31st request
 *     is allowed immediately because credit is still in the bucket.
 *   - Once fully drained, the next token takes ~1500 ms to refill.
 */
export class TokenBucket {
    #capacity;
    #windowMs;
    #msPerToken;
    #creditMs;
    #lastRefill;
    #clock;

    /**
     * @param {number} capacity - Maximum tokens the bucket can hold.
     * @param {number} windowMs - Time window over which `capacity`
     *   tokens are replenished, in milliseconds.
     * @param {() => number} [now=performance.now] - Function returning a
     *   monotonic timestamp in milliseconds. Intended primarily for testing.
     * @throws {TypeError} If `capacity` or `windowMs` is not a positive
     *   finite number.
     */
    constructor(capacity, windowMs, now = () => performance.now()) {
        if (!Number.isFinite(capacity) || capacity <= 0) {
            throw new TypeError('capacity must be a positive finite number');
        }

        if (!Number.isFinite(windowMs) || windowMs <= 0) {
            throw new TypeError('windowMs must be a positive finite number');
        }

        this.#capacity = capacity;
        this.#windowMs = windowMs;
        this.#msPerToken = windowMs / capacity;
        this.#creditMs = windowMs; // starts full: capacity tokens' worth of credit

        this.#clock = now;
        this.#lastRefill = this.#clock();
    }

    /**
     * Compute the current credit in milliseconds.
     *
     * Lazily adds `elapsed` milliseconds since `#lastRefill`, capped at
     * `#windowMs`. This is a pure function: it does not mutate state.
     *
     * @param {number} [now] - Timestamp to compute availability at.
     *   Defaults to the injected clock.
     * @returns {number} Current credit in milliseconds, range [0, windowMs].
     */
    #availableCreditMs(now = this.#clock()) {
        const elapsed = now - this.#lastRefill;
        return Math.min(this.#windowMs, this.#creditMs + elapsed);
    }

    /**
     * Peek at the number of tokens currently available.
     *
     * This is a read-only snapshot: it computes how many tokens would be
     * available right now based on elapsed time since the last refill, but
     * does NOT mutate the bucket state. Use this for selection/sorting;
     * use `acquire()` to actually consume a token.
     *
     * @returns {number} Floored token count (e.g. 3.7 → 3). Returns
     *   `#capacity` when the bucket is exactly full, bypassing a
     *   floating-point division edge case.
     */
    peekTokens() {
        const creditMs = this.#availableCreditMs();

        // Guard against floating-point undershoot when the bucket is exactly
        // full. `windowMs / msPerToken` should equal `capacity`, but IEEE-754
        // division can produce `2.9999999999999996` instead of `3`.
        if (creditMs >= this.#windowMs) {
            return this.#capacity;
        }

        // Guard against floating-point undershoot. After subtracting msPerToken,
        // creditMs can be epsilon-smaller than the exact mathematical value,
        // causing floor() to undercount by 1.
        const tokens = creditMs / this.#msPerToken;

        return Math.floor(Math.min(tokens + EPS, this.#capacity));
    }

    /**
     * Timestamp of the last state update.
     *
     * Updated whenever a token is consumed. Combined with the stored credit,
     * it allows the bucket to lazily compute the current number of available
     * tokens without running a background refill task.
     *
     * @returns {number} Monotonic timestamp from the injected clock.
     */
    get lastRefill() {
        return this.#lastRefill;
    }

    /**
     * Returns the time (ms) until `count` tokens are available.
     *
     * @param {number} [count=1] - Required number of tokens. Must be a
     *   positive finite number.
     * @returns {number} Milliseconds until enough tokens exist, or
     *   `Infinity` if `count` exceeds the bucket's capacity and can never
     *   be satisfied.
     * @throws {TypeError} If `count` is not a positive finite number.
     */
    timeUntil(count = 1) {
        if (!Number.isFinite(count) || count <= 0) {
            throw new TypeError('count must be a positive finite number');
        }

        if (count > this.#capacity) {
            return Infinity;
        }

        const availableCreditMs = this.#availableCreditMs(this.#clock());

        // Full bucket: any count ≤ capacity is satisfied immediately.
        if (availableCreditMs >= this.#windowMs) {
            return 0;
        }

        const neededCreditMs = count * this.#msPerToken;

        if (availableCreditMs >= neededCreditMs) {
            return 0;
        }

        return Math.ceil(neededCreditMs - availableCreditMs);
    }

    /**
     * Acquire one token, blocking until available or the timeout expires.
     *
     * Algorithm:
     *   1. Compute elapsed time since last refill.
     *   2. Add back proportional credit (capped at windowMs).
     *   3. If at least one token's worth of credit is available: deduct the
     *      cost, update `#lastRefill`, and return immediately.
     *   4. Otherwise: sleep exactly until the next token is ready
     *      (not a fixed interval), then loop.
     *
     * The sleep duration is calculated precisely: if 750 ms of credit are
     * needed and the rate is 1 token per 1500 ms, it sleeps 750 ms.
     * This minimizes unnecessary waiting under high concurrency.
     *
     * @param {number} [timeoutMs=30000] - Maximum time to wait for a token.
     *   Must be a non-negative finite number.
     * @returns {Promise<void>} Resolves when a token is consumed.
     * @throws {TypeError} If `timeoutMs` is not a non-negative finite number.
     * @throws {TokenBucketTimeoutError} If no token becomes available
     *   within `timeoutMs`.
     */
    async acquire(timeoutMs = 30000) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
            throw new TypeError('timeoutMs must be a non-negative finite number');
        }

        const deadline = this.#clock() + timeoutMs;
        const costMs = this.#msPerToken;

        for (;;) {
            const now = this.#clock();
            const availableCreditMs = this.#availableCreditMs(now);

            if (availableCreditMs + EPS >= costMs) {
                this.#creditMs = availableCreditMs - costMs;
                this.#lastRefill = now;
                return;
            }

            const sleepMs = Math.min(Math.ceil(costMs - availableCreditMs), deadline - now);

            if (sleepMs <= 0) {
                throw new TokenBucketTimeoutError(timeoutMs);
            }

            await new Promise((resolve) => {
                setTimeout(resolve, sleepMs);
            });
        }
    }
}
