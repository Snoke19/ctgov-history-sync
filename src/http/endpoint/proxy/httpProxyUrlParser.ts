import { createLogger } from '../../../config/logging.js';

const logger = createLogger(import.meta.url);

export interface ProxyUrlParser {
    parse(input: string): string[];
}

export class HttpProxyUrlParser implements ProxyUrlParser {
    parse(proxyUrls: string): string[] {
        if (!proxyUrls) {
            return [];
        }

        const urls: string[] = [];

        for (const raw of String(proxyUrls).split(',')) {
            const url = raw.trim();

            try {
                const parsed = new URL(url);

                const validProtocol = parsed.protocol === 'http:' || parsed.protocol === 'https:';
                const validHost = Boolean(parsed.hostname);
                const validPort = hasExplicitPort(url);
                const validOrigin = parsed.pathname === '/' && !parsed.search && !parsed.hash;

                if (!validProtocol || !validHost || !validPort || !validOrigin) {
                    logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', sanitizeProxyUrl(url));
                    continue;
                }

                urls.push(url);
            } catch {
                logger.warn('[Proxy] Skipping invalid proxy URL: "%s"', sanitizeProxyUrl(url));
            }
        }

        return urls;
    }
}

function sanitizeProxyUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return '<invalid proxy URL>';
    }
}

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
    const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;

    const match = hostPort.match(/:(\d+)$/);
    if (!match) {
        return false;
    }

    const portText = match[1];
    if (!portText) {
        return false;
    }

    const port = Number.parseInt(portText, 10);
    return port > 0 && port <= 65535;
}
