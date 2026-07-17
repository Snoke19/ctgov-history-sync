import {Pool, ProxyAgent} from 'undici';
import {
    ACQUIRE_TIER,
    ACQUIRE_TIMEOUT,
    POOL_BODY_TIMEOUT,
    POOL_CONNECTIONS,
    POOL_HEADERS_TIMEOUT,
    POOL_KEEP_ALIVE_TIMEOUT,
    POOL_PIPELINING,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    raw
} from "../config/config.js";
import {logger} from "../config/logging.js";

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

const poolFactory = (url, opts) => {
    return new Pool(url, {
        ...opts,
        connections: POOL_CONNECTIONS,
        pipelining: POOL_PIPELINING,
        keepAliveTimeout: POOL_KEEP_ALIVE_TIMEOUT,
        headersTimeout: POOL_HEADERS_TIMEOUT,
        bodyTimeout: POOL_BODY_TIMEOUT,
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
            limiter: new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_WINDOW),
            failures: 0
        }));

logger.info(
    'Proxy pool initialized | Count: %d | RateLimit: %d/%dms | Connections: %d',
    proxyAgents.length,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    POOL_CONNECTIONS
);

export function reportProxyResult(proxyUrl, success) {
    const proxy = proxyAgents.find(a => a.url === proxyUrl);
    if (!proxy) return;
    proxy.failures = success ? Math.max(0, proxy.failures - 1) : proxy.failures + 1;
}

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
export async function acquireProxyDispatcher(timeoutMs = ACQUIRE_TIMEOUT) {
    if (proxyAgents.length === 0) {
        return undefined;
    }

    // Proxies that have at least 1 full token right now
    const available = proxyAgents
        .filter(a => a.limiter.peekTokens() > 0)
        .sort((a, b) => {
            if (a.failures !== b.failures) return a.failures - b.failures;
            return b.limiter.peekTokens() - a.limiter.peekTokens();
        });

    logger.debug(
        'Proxy selection | Available: %d/%d | Top tokens: %j',
        available.length,
        proxyAgents.length,
        available.slice(0, 3).map(a => ({url: a.url, tokens: a.limiter.peekTokens()}))
    );

    if (available.length > 0) {
        const tierSize = Math.min(ACQUIRE_TIER, available.length);
        const pick = available[Math.floor(Math.random() * tierSize)];

        logger.debug('Acquiring proxy token | Proxy: %s | Tokens: %d', pick.url, pick.limiter.peekTokens());
        await pick.limiter.acquire(timeoutMs);
        logger.debug('Proxy token acquired | Proxy: %s', pick.url);

        return pick;
    }

    // All proxies exhausted: pick the one that will wake up first.
    // Oldest lastRefill = most accumulated refill time = reaches 1 token first.
    const soonest = [...proxyAgents].sort(
        (a, b) => a.limiter.lastRefill - b.limiter.lastRefill
    );

    logger.debug(
        'All proxies exhausted | Waiting on: %s | LastRefill: %dms ago',
        soonest[0].url,
        Date.now() - soonest[0].limiter.lastRefill
    );

    await soonest[0].limiter.acquire(timeoutMs);
    logger.debug('Proxy token acquired after wait | Proxy: %s', soonest[0].url);

    return soonest[0];
}
