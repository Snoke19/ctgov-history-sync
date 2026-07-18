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
import {TokenBucket} from "./tokenBucket.js";

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
 *      Finds the proxy with the shortest wait until the next token becomes
 *      available and waits on that proxy's TokenBucket.acquire().
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
    // Find the proxy whose rate limiter will produce the next available token
    // the soonest.
    let soonest = proxyAgents[0];
    let waitMs = soonest.limiter.timeUntil(1);

    for (let i = 1; i < proxyAgents.length; i++) {
        const proxy = proxyAgents[i];
        const wait = proxy.limiter.timeUntil(1);

        if (wait < waitMs) {
            waitMs = wait;
            soonest = proxy;
        }
    }

    logger.debug(
        'All proxies exhausted | Waiting on: %s | Wait: %dms | Failures: %d',
        soonest.url,
        waitMs,
        soonest.failures,
    );

    await soonest.limiter.acquire(timeoutMs);

    logger.debug(
        'Proxy token acquired after wait | Proxy: %s',
        soonest.url,
    );

    return soonest;
}
