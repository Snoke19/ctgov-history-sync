import {sleep} from './retry.js';
import {logger} from './logging.js';

/**
 * How long we're willing to honour a Retry-After header before capping it.
 * The internal detail API sometimes sends 600s which would stall everything
 * for 10 minutes per 429 — cap it to something sane and let jitter handle
 * the remainder.
 */
const MAX_RETRY_AFTER_MS = 30_000; // 30 s

/**
 * Global rate-limit coordinator shared across all concurrent workers.
 *
 * Two mechanisms:
 *
 * 1. **Reactive throttle** — when ANY worker receives a 429, it calls
 *    reportThrottle() which sets a shared "pause until" timestamp. Every
 *    subsequent worker checks this gate before firing, so the whole pool
 *    backs off together (no thundering herd).
 *
 * 2. **Proactive token bucket** — enforces a minimum gap between consecutive
 *    requests across the entire pool. This keeps the aggregate request rate
 *    below the server's tolerance _before_ getting a 429, rather than only
 *    reacting after one.
 */
export class RateLimiter {
    /** @type {number} absolute ms timestamp until which all workers should wait */
    #throttleUntil = 0;

    /** @type {number} running count of 429s seen this session */
    #throttleCount = 0;

    /**
     * Minimum gap between any two consecutive requests across all workers.
     * Set to 0 to disable the proactive throttle.
     * @type {number}
     */
    #minGapMs;

    /** @type {number} timestamp of the last request that was allowed through */
    #lastAllowedMs = 0;

    /**
     * @param {number} [minGapMs=0] proactive inter-request gap in ms (0 = disabled)
     */
    constructor(minGapMs = 0) {
        this.#minGapMs = minGapMs;
    }

    /**
     * Must be called by every worker before firing an HTTP request.
     * Enforces both the reactive global throttle and the proactive min-gap.
     */
    async wait() {
        // ── 1. Reactive: wait out any global throttle ──────────────────────
        const now1 = Date.now();
        const throttleWait = this.#throttleUntil - now1;
        if (throttleWait > 0) {
            await sleep(throttleWait);
        }

        // ── 2. Proactive: enforce minimum inter-request gap ─────────────────
        if (this.#minGapMs > 0) {
            const now2 = Date.now();
            const gapWait = (this.#lastAllowedMs + this.#minGapMs) - now2;
            if (gapWait > 0) {
                await sleep(gapWait);
            }
            this.#lastAllowedMs = Date.now();
        }
    }

    /**
     * Called by a worker that received a 429 response.
     * @param {number} retryAfterMs - how long to pause (from Retry-After or fallback)
     */
    reportThrottle(retryAfterMs) {
        this.#throttleCount++;
        // Cap: never stall the whole pool for more than MAX_RETRY_AFTER_MS
        const capped = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
        const until = Date.now() + capped;
        if (until > this.#throttleUntil) {
            this.#throttleUntil = until;
            const orig = (retryAfterMs / 1000).toFixed(0);
            const used = (capped / 1000).toFixed(1);
            const cappedNote = capped < retryAfterMs ? ` (server wanted ${orig}s, capped to ${used}s)` : '';
            logger.warn(`[RateLimiter] Global throttle for ${used}s${cappedNote} (total 429s: ${this.#throttleCount})`);
        }
    }

    get throttleCount() { return this.#throttleCount; }
}
