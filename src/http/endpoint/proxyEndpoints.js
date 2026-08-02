import {ProxyEndpoint} from './proxyEndpoint.js';
import {logger} from '../../config/logging.js';

/**
 * Supported format:
 *
 *   http://user:password@host:port
 *   https://user:password@host:port
 *
 * Intentionally rejected:
 *
 * - socks proxies
 * - trailing slash
 * - usernames/passwords containing ':' or '@'
 * - missing credentials
 */
const PROXY_URL_REGEX = /^(https?):\/\/([^:@/]+):([^:@/]+)@([^:@/]+):(\d+)$/;

/**
 * Creates ProxyEndpoint instances from a comma-separated list of proxy URLs.
 *
 * @param {string} proxyUrls
 * @param {() => (TokenBucket|UnlimitedLimiter)} createLimiter
 * @param {object} [options]
 * @param {number} [options.concurrency] - Global CONCURRENCY, used to size each
 *   proxy's connection pool relative to the number of valid proxies.
 * @param {object} [options.poolConfig] - PROXY_POOL_CONFIG (connections, maxConnections,
 *   pipelining, keepAliveTimeout, headersTimeout, bodyTimeout, connectTimeout).
 * @returns {ProxyEndpoint[]}
 */
export function createProxyEndpoints(proxyUrls, createLimiter, {concurrency, poolConfig} = {}) {
    if (!proxyUrls) {
        return [];
    }

    const validUrls = [];

    for (const raw of String(proxyUrls).split(',')) {
        const url = raw.trim();

        if (!PROXY_URL_REGEX.test(url)) {
            logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);
            continue;
        }

        validUrls.push(url);
    }

    const proxyCount = validUrls.length;

    return validUrls.map(
        (url) =>
            new ProxyEndpoint(url, createLimiter(), {proxyCount, concurrency, poolConfig}),
    );
}