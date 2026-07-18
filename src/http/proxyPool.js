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
    raw,
} from '../config/config.js';
import {logger} from '../config/logging.js';
import {performance} from 'node:perf_hooks';

/**
 * Token bucket rate limiter.
 *
 * Models a bucket that holds up to `capacity` tokens. Each token represents
 * one permitted request. Tokens refill smoothly over time at a rate of
 * `capacity / windowMs` tokens per millisecond.
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
class TokenBucket {
    #capacity;
    #windowMs;
    #lastRefill;
    #availableTokens;

    /**
     * @param {number} capacity - Maximum tokens the bucket can hold.
     * @param {number} windowMs - Time window over which `capacity` tokens
     *   are replenished, in milliseconds.
     */
    constructor(capacity, windowMs) {
        this.#capacity = capacity;
        this.#availableTokens = capacity;
        this.#windowMs = windowMs;
        this.#lastRefill = performance.now();
    }

    #available(now = performance.now()) {
        const refillRate = this.#capacity / this.#windowMs;
        const elapsed = now - this.#lastRefill;

        return Math.min(
            this.#capacity,
            this.#availableTokens + elapsed * refillRate,
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
     * Timestamp of the last token refill.
     *
     * Used by the "all exhausted" fallback in `acquireProxyDispatcher` to
     * pick the proxy that has accumulated the most refill time and will
     * therefore reach 1 token soonest.
     *
     * @returns {number} Unix timestamp in milliseconds.
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
        const msPerToken = this.#windowMs / this.#capacity;

        return Math.ceil(tokensNeeded * msPerToken);
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
        const deadline = performance.now() + timeoutMs;

        for (; ;) {
            const now = performance.now();
            const available = this.#available(now);

            if (available >= 1) {
                this.#availableTokens = available - 1;
                this.#lastRefill = now;
                return;
            }

            const sleepMs = Math.min(
                this.timeUntil(1),
                deadline - performance.now(),
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

/**
 * Factory for `undici.Pool` instances.
 *
 * Each proxy gets its own Pool, which manages a fixed number of persistent
 * TCP connections. Tuned for high-throughput proxy usage:
 *
 *   connections: 50        – Max concurrent TCP sockets per proxy.
 *   pipelining: 1            – One request in flight per connection
 *                            (safer for proxies; disable HTTP pipelining).
 *   keepAliveTimeout: 5 min – Reuse connections across requests.
 *   headersTimeout: 15 s     – Max wait for response headers.
 *   bodyTimeout: 45 s       – Max wait for full response body.
 *
 * @param {string} url - The proxy URL (used by undici for connection targeting).
 * @param {object} opts - Additional pool options.
 * @returns {Pool}
 */
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
 * @property {string} url - The proxy URL (for logging and health tracking).
 * @property {ProxyAgent} dispatcher - The undici ProxyAgent instance.
 * @property {TokenBucket} limiter - Per-proxy rate limiter.
 * @property {number} failures - Recent failure count (health score).
 */

/**
 * The active proxy pool. Parsed from the PROXY_IP environment variable.
 *
 * Empty if:
 *   - NODE_ENV === 'test' (bypass proxies in test mode).
 *   - PROXY_IP is empty or unset (direct connection mode).
 *
 * Each entry gets:
 *   - A ProxyAgent wrapping a custom Pool.
 *   - A TokenBucket enforcing RATE_LIMIT_CAPACITY / RATE_LIMIT_WINDOW.
 *   - A failures counter starting at 0.
 *
 * @type {ProxyAgentEntry[]}
 */
const proxyAgents =
    process.env.NODE_ENV === 'test' || raw.length === 0
        ? []
        : raw
            .split(',')
            .map((url) => url.trim())
            .filter((url) => url.startsWith('http'))
            .map((url) => ({
                url,
                dispatcher: new ProxyAgent({uri: url, clientFactory: poolFactory}),
                limiter: new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_WINDOW),
                failures: 0,
            }));

/**
 * Fast lookup table for proxy entries by URL.
 *
 * Used by reportProxyHealth() to avoid a linear scan on every request.
 *
 * @type {Map<string, ProxyAgentEntry>}
 */
const proxyByUrl = new Map(
    proxyAgents.map(proxy => [proxy.url, proxy]),
);

// Log the initial pool state so operators can verify configuration at startup.
logger.info(
    'Proxy pool initialized | Count: %d | RateLimit: %d/%dms | Connections: %d',
    proxyAgents.length,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    POOL_CONNECTIONS,
);

/**
 * Reports the outcome of a request to the proxy health tracker.
 *
 * Health model: exponential decay on success, linear growth on failure.
 *
 *   Success: failures = floor(failures × 0.5)
 *     10 → 5 → 2 → 1 → 0  (recovers in ~4 successes)
 *
 *   Failure: failures += 1
 *     0 → 1 → 2 → 3 …     (grows linearly)
 *
 * This makes "dead" proxies recover quickly once they start working again,
 * while unstable proxies accumulate failures and are deprioritized.
 *
 * @param {string} proxyUrl - The proxy URL returned by acquireProxyDispatcher.
 * @param {boolean} success - Whether the request succeeded.
 */
export function reportProxyHealth(proxyUrl, success) {
    const proxy = proxyByUrl.get(proxyUrl);
    if (!proxy) {
        return;
    }

    if (success) {
        // Exponential decay: recover quickly from transient failures.
        proxy.failures = Math.floor(proxy.failures * 0.5);
    } else {
        // Linear growth: penalize repeated failures.
        proxy.failures += 1;
    }
}

/**
 * Acquires a proxy dispatcher for an outgoing HTTP request.
 *
 * Selection strategy (in priority order):
 *
 *   1. NO PROXIES CONFIGURED
 *      Returns undefined → caller uses direct connection.
 *
 *   2. PROXIES WITH AVAILABLE TOKENS
 *      Filters to proxies that have ≥1 full token right now.
 *      Sorts by: (a) lowest failures first, (b) most tokens second.
 *      Picks randomly from the top ACQUIRE_TIER entries.
 *      This balances load while favoring healthy, well-rested proxies.
 *
 *   3. ALL PROXIES EXHAUSTED
 *      Sorts by oldest `lastRefill` → most accumulated refill time.
 *      Waits on that proxy's TokenBucket.acquire().
 *
 * The returned entry MUST be used for exactly one request. The caller
 * (httpClient.js) is responsible for reporting the result via
 * `reportProxyHealth()` so the health score stays accurate.
 *
 * @param {number} [timeoutMs=30000] - Maximum time to wait for a proxy
 *   token. Passed through to TokenBucket.acquire().
 * @returns {Promise<ProxyAgentEntry|undefined>} The selected proxy entry,
 *   or undefined if no proxies are configured.
 */
export async function acquireProxyDispatcher(timeoutMs = ACQUIRE_TIMEOUT) {
    // Fast path: no proxies → direct connection.
    if (proxyAgents.length === 0) {
        return undefined;
    }

    // -----------------------------------------------------------------------
    // Phase 1: Proxies with available tokens right now.
    // -----------------------------------------------------------------------
    const availableProxy = proxyAgents
        .map(proxy => ({
            proxy,
            failures: proxy.failures,
            tokens: proxy.limiter.peekTokens()
        }))
        .filter(item => item.tokens > 0)
        // Full sort is acceptable here because the proxy pool is expected
        // to remain relatively small (<100). Revisit with a top-k selection
        // algorithm if the pool grows significantly.
        .sort((a, b) => {
            // Primary: health (fewer failures = better).
            if (a.failures !== b.failures) {
                return a.failures - b.failures;
            }
            // Secondary: token wealth (more tokens = better).
            return b.tokens - a.tokens;
        });

    logger.debug(
        'Proxy selection | Available: %d/%d | Top tokens: %j',
        availableProxy.length,
        proxyAgents.length,
        availableProxy.slice(0, 3).map(a => ({
            url: a.proxy.url,
            tokens: a.tokens,
            failures: a.failures,
        })),
    );

    if (availableProxy.length > 0) {
        // Random pick from the top tier prevents herding on a single proxy.
        const tierSize = Math.min(ACQUIRE_TIER, availableProxy.length);
        const pick = availableProxy[Math.floor(Math.random() * tierSize)];

        logger.debug(
            'Acquiring proxy token | Proxy: %s | Tokens: %d | Failures: %d',
            pick.proxy.url,
            pick.tokens,
            pick.failures,
        );

        await pick.proxy.limiter.acquire(timeoutMs);
        logger.debug('Proxy token acquired | Proxy: %s', pick.proxy.url);

        return pick.proxy;
    }

    // -----------------------------------------------------------------------
    // Phase 2: All proxies exhausted — wait for the one that wakes first.
    // -----------------------------------------------------------------------
    // Choose the proxy with the shortest wait until one token is available.
    const soonest = [...proxyAgents]
        .sort((a, b) =>
            a.limiter.timeUntil(1) - b.limiter.timeUntil(1)
        );
    const waitMs = soonest[0].limiter.timeUntil(1);

    logger.debug(
        'All proxies exhausted | Waiting on: %s | Wait: %dms | Failures: %d',
        soonest[0].url,
        waitMs,
        soonest[0].failures,
    );

    await soonest[0].limiter.acquire(timeoutMs);

    logger.debug('Proxy token acquired after wait | Proxy: %s', soonest[0].url);

    return soonest[0];
}
