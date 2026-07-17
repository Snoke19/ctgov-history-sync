import {Pool, ProxyAgent} from 'undici';

/**
 * Token bucket rate limiter.
 *
 * Allows up to `capacity` requests per `windowMs`, with smooth refill.
 * Safe for concurrent async usage (Node.js single-threaded event loop).
 */
class TokenBucket {
    #capacity;
    #tokens;
    #windowMs;
    #lastRefill;

    /**
     * @param {number} capacity - Max tokens in the bucket.
     * @param {number} windowMs - Time window in milliseconds.
     */
    constructor(capacity, windowMs) {
        this.#capacity = capacity;
        this.#tokens = capacity;
        this.#windowMs = windowMs;
        this.#lastRefill = Date.now();
    }

    /**
     * Read-only peek at available tokens (floored).
     * Does NOT mutate state.
     * @returns {number}
     */
    peekTokens() {
        const now = Date.now();
        const elapsed = now - this.#lastRefill;
        const refill = elapsed * (this.#capacity / this.#windowMs);
        return Math.floor(Math.min(this.#capacity, this.#tokens + refill));
    }

    /**
     * Timestamp of last refill. Used for "soonest wake" fallback.
     * @returns {number}
     */
    get lastRefill() {
        return this.#lastRefill;
    }

    /**
     * Acquire one token. Blocks until available or timeout.
     * @param {number} [timeoutMs=30000]
     * @returns {Promise<void>}
     * @throws {Error} If timeout exceeded.
     */
    async acquire(timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;

        for (; ;) {
            const now = Date.now();
            const elapsed = now - this.#lastRefill;
            const refill = elapsed * (this.#capacity / this.#windowMs);

            if (refill > 0) {
                this.#tokens = Math.min(this.#capacity, this.#tokens + refill);
                this.#lastRefill = now;
            }

            if (this.#tokens >= 1) {
                this.#tokens -= 1;
                return;
            }

            // Exact time until next token (e.g. 0.3 tokens left → 450ms, not 1500ms)
            const tokensNeeded = 1 - this.#tokens;
            const msPerToken = this.#windowMs / this.#capacity;
            const sleepMs = Math.min(
                Math.ceil(tokensNeeded * msPerToken),
                deadline - Date.now()
            );

            if (sleepMs <= 0) {
                throw new Error(
                    `TokenBucket timeout: no token available within ${timeoutMs}ms`
                );
            }

            await new Promise(r => setTimeout(r, sleepMs));
        }
    }
}

const raw = process.env.PROXY_IP || '';

/**
 * Factory for undici Pool instances.
 * Tuned for high-throughput proxy usage.
 */
const poolFactory = (url, opts) => {
    return new Pool(url, {
        ...opts,
        connections: 50,
        pipelining: 1,
        keepAliveTimeout: 300_000,
        headersTimeout: 15_000,
        bodyTimeout: 45_000,
    });
};

/**
 * @typedef {Object} ProxyAgentEntry
 * @property {string} url
 * @property {ProxyAgent} dispatcher
 * @property {TokenBucket} limiter
 */

/** @type {ProxyAgentEntry[]} */
const proxyAgents = (process.env.NODE_ENV === 'test' || raw.length === 0) ? []
    : raw
        .split(',')
        .map(url => url.trim())
        .filter(url => url.startsWith('http'))
        .map(url => ({
            url,
            dispatcher: new ProxyAgent({uri: url, clientFactory: poolFactory}),
            limiter: new TokenBucket(40, 60_000),
        }));

/**
 * Acquire a proxy dispatcher with rate-limited selection.
 *
 * Strategy:
 * 1. No proxies → undefined (direct connection).
 * 2. Pick randomly from top-3 proxies with most available tokens.
 *    Prevents herding on a single "richest" proxy.
 * 3. If all exhausted → wait on the proxy with oldest lastRefill
 *    (accumulated the most refill time, wakes first).
 *
 * @param {number} [timeoutMs=30000] - Max time to wait for a token.
 * @returns {Promise<ProxyAgentEntry|undefined>}
 */
export async function acquireProxyDispatcher(timeoutMs = 30000) {
    if (proxyAgents.length === 0) {
        return undefined;
    }

    // Proxies that have at least 1 full token right now
    const available = proxyAgents
        .filter(a => a.limiter.peekTokens() > 0)
        .sort((a, b) => b.limiter.peekTokens() - a.limiter.peekTokens());

    if (available.length > 0) {
        const tierSize = Math.min(3, available.length);
        const pick = available[Math.floor(Math.random() * tierSize)];
        await pick.limiter.acquire(timeoutMs);
        return pick;
    }

    // All proxies exhausted: pick the one that will wake up first.
    // Oldest lastRefill = most accumulated refill time = reaches 1 token first.
    const soonest = [...proxyAgents].sort(
        (a, b) => a.limiter.lastRefill - b.limiter.lastRefill
    );

    await soonest[0].limiter.acquire(timeoutMs);
    return soonest[0];
}
