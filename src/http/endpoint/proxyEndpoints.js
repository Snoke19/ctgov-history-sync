import {ProxyEndpoint} from './proxyEndpoint.js';
import {logger} from '../../config/logging.js';

/**
 * Supported formats:
 *
 *   http://host:port
 *   http://user:password@host:port
 *   https://host:port
 *   https://user:password@host:port
 *
 * Validation uses Node.js's built-in URL parser. Only HTTP and HTTPS proxy
 * URLs with an explicit host and port are accepted. Credentials are optional
 * (IP-whitelisted proxies are supported).
 *
 * Note: usernames/passwords containing reserved characters (@, :, #, ?, /, [, ])
 * must be percent-encoded in the source URL (e.g. encodeURIComponent on each
 * part before building the string) — the URL parser will otherwise misparse
 * or reject the authority section.
 */

/**
 * Creates ProxyEndpoint instances from a comma-separated list of proxy URLs.
 *
 * @param {string} proxyUrls
 * @param {() => (TokenBucket|UnlimitedLimiter)} createLimiter
 * @param {object} [options]
 * @param {number} [options.concurrency] - Global concurrency used to size each
 *   proxy's connection pool.
 * @param {object} [options.poolConfig] - Pool configuration.
 * @returns {ProxyEndpoint[]}
 */
export function createProxyEndpoints(proxyUrls, createLimiter, {concurrency, poolConfig} = {}) {
    if (!proxyUrls) {
        return [];
    }

    const validUrls = [];

    for (const raw of String(proxyUrls).split(',')) {
        const url = raw.trim();

        try {
            const parsed = new URL(url);

            const validProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';
            const hasHost = Boolean(parsed.hostname);
            // parsed.port is '' both when no port was given AND when the port
            // equals the scheme's default (80/443) — so it can't be used alone
            // to detect an explicit port. Comparing host vs hostname works in
            // both cases: host includes the port, hostname never does.
            const hasExplicitPort = parsed.host !== parsed.hostname;

            if (!validProtocol || !hasHost || !hasExplicitPort) {
                logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);
                continue;
            }

            validUrls.push(url);
        } catch {
            logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);
        }
    }

    const proxyCount = validUrls.length;

    return validUrls.map(
        (url) =>
            new ProxyEndpoint(url, createLimiter(), {
                proxyCount,
                concurrency,
                poolConfig,
            }),
    );
}