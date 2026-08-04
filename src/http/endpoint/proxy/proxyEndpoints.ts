import { ProxyEndpoint } from './proxyEndpoint.js';
import { ProxyEndpointFactory } from './proxyEndpointFactory.js';
import { logger } from '../../../config/logging.js';
import { ProxyPoolConfig } from '../../../config/config.js';
import { Limiter } from '../../limiter/limiter.js';
import { UndiciProxyDispatcherFactory } from './undiciProxyDispatcherFactory.js';
import { CreateProxyEndpointsOptions } from '../types/endpointOptions.js';

/**
 * Supported formats:
 *
 *   http://host:port
 *   http://user:password@host:port
 *   https://host:port
 *   https://user:password@host:port
 *
 * Validation uses Node.js's built-in URL parser for everything except the
 * port. The URL spec nulls out the port at parse time whenever it equals
 * the scheme's default (80 for http, 443 for https) — parsed.port and
 * parsed.host are indistinguishable from a URL with no port at all in that
 * case. So an explicit port is detected separately, from the raw string's
 * authority segment, before parsing.
 */
function hasExplicitPort(url: string): boolean {
    const schemeEnd = url.indexOf('://');
    if (schemeEnd === -1) {
        return false;
    }

    const afterScheme = url.slice(schemeEnd + 3);
    const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
    const hostPort = authority.includes('@')
        ? authority.slice(authority.lastIndexOf('@') + 1)
        : authority;

    return /:\d+$/.test(hostPort);
}

export function createProxyEndpoints(
    proxyUrls: string,
    createLimiter: () => Limiter,
    concurrency: number,
    poolConfig: ProxyPoolConfig,
): ProxyEndpoint[] {
    if (!proxyUrls) {
        return [];
    }

    const validUrls: string[] = [];

    for (const raw of String(proxyUrls).split(',')) {
        const url = raw.trim();

        try {
            const parsed = new URL(url);

            const validProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';
            const validHost = Boolean(parsed.hostname);
            const validPort = hasExplicitPort(url);

            if (!validProtocol || !validHost || !validPort) {
                logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);
                continue;
            }

            validUrls.push(url);
        } catch {
            logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', url);
        }
    }

    const proxyCount = validUrls.length;

    const factory = new ProxyEndpointFactory(new UndiciProxyDispatcherFactory());

    const options: CreateProxyEndpointsOptions = { concurrency, poolConfig, proxyCount };

    return validUrls.map((url) => {
        const limiter = createLimiter();
        return factory.create(url, limiter, options);
    });
}