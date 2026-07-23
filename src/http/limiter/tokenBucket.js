import {performance} from 'node:perf_hooks';
import {TokenBucketTimeoutError} from '../../error/errors.js';
import {Limiter} from "./limiter.js";

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
export class TokenBucket extends Limiter {
    #capacity;
    #windowMs;
    #msPerToken;
    #creditMs;
    #lastUpdate;
    #clock;

    /**
     * @param {number} capacity - Maximum tokens the bucket can hold. Must be
     *   a positive integer — fractional capacities can make `timeUntil`
     *   permanently unsatisfiable since acquisition always consumes whole
     *   tokens.
     * @param {number} windowMs - Time window over which `capacity`
     *   tokens are replenished, in milliseconds.
     * @param {() => number} [now=performance.now] - Function returning a
     *   monotonic timestamp in milliseconds. Intended primarily for testing.
     * @throws {TypeError} If `capacity` is not a positive integer, or
     *   `windowMs` is not a positive finite number.
     */
    constructor(capacity, windowMs, now = () => performance.now()) {
        super();

        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new TypeError('capacity must be a positive integer');
        }

        if (!Number.isFinite(windowMs) || windowMs <= 0) {
            throw new TypeError('windowMs must be a positive finite number');
        }

        this.#capacity = capacity;
        this.#windowMs = windowMs;
        this.#msPerToken = windowMs / capacity;
        this.#creditMs = windowMs; // starts full: capacity tokens' worth of credit

        this.#clock = now;
        this.#lastUpdate = this.#clock();
    }

    /**
     * Compute the current credit in milliseconds.
     *
     * Lazily adds `elapsed` milliseconds since `#lastUpdate`, capped at
     * `#windowMs`. Elapsed time is clamped to zero so an injected
     * non-monotonic clock (e.g. in tests) can't drain credit by going
     * backwards. This is a pure function: it does not mutate state.
     *
     * @param {number} [now] - Timestamp to compute availability at.
     *   Defaults to the injected clock.
     * @returns {number} Current credit in milliseconds, range [0, windowMs].
     */
    #availableCreditMs(now = this.#clock()) {
        const elapsed = Math.max(0, now - this.#lastUpdate);
        return Math.min(this.#windowMs, this.#creditMs + elapsed);
    }

    tryAcquire() {
        const now = this.#clock();
        const availableCreditMs = this.#availableCreditMs(now);

        if (availableCreditMs + EPS < this.#msPerToken) {
            return false;
        }

        this.#creditMs = availableCreditMs - this.#msPerToken;
        this.#lastUpdate = now;
        return true;
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
    get lastUpdate() {
        return this.#lastUpdate;
    }

    /**
     * Maximum tokens this bucket can hold.
     * @returns {number}
     */
    get capacity() {
        return this.#capacity;
    }

    /**
     * Refill window in milliseconds.
     * @returns {number}
     */
    get windowMs() {
        return this.#windowMs;
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

        // EPS tolerance mirrors tryAcquire(), so timeUntil() and tryAcquire()
        // never disagree about whether a token is available right now.
        if (availableCreditMs + EPS >= neededCreditMs) {
            return 0;
        }

        return Math.ceil(neededCreditMs - availableCreditMs);
    }

    timeUntilToken() {
        return this.timeUntil(1);
    }

    /**
     * Acquire one token, blocking until available or the timeout expires.
     *
     * Algorithm:
     *   1. Compute elapsed time since last refill.
     *   2. Add back proportional credit (capped at windowMs).
     *   3. If at least one token's worth of credit is available: deduct the
     *      cost, update `#lastUpdate`, and return immediately.
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

        while (true) {
            if (this.tryAcquire()) {
                return;
            }

            const remaining = deadline - this.#clock();

            if (remaining <= 0) {
                throw new TokenBucketTimeoutError(timeoutMs);
            }

            await new Promise(resolve =>
                setTimeout(resolve, Math.min(this.timeUntilToken(), remaining)),
            );
        }
    }
}
