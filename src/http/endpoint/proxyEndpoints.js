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
 * @returns {ProxyEndpoint[]}
 */
export function createProxyEndpoints(proxyUrls, createLimiter) {
    const endpoints = [];

    if (!proxyUrls) {
        return endpoints;
    }

    for (const raw of String(proxyUrls).split(',')) {
        const url = raw.trim();

        if (!PROXY_URL_REGEX.test(url)) {
            logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);
            continue;
        }

        endpoints.push(new ProxyEndpoint(url, createLimiter()));
    }

    return endpoints;
}