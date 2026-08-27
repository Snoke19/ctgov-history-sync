/**
 * Centralized URL sanitization helpers.
 *
 * All functions are pure and never throw. They strip credentials,
 * query params and fragments so proxy/API credentials never leak
 * through err.message, err.url or logs.
 *
 * Extracted from duplicated helpers in:
 * - src/error/errors.ts:167 stripUserInfo
 * - src/http/transport/impl/undiciProxyTransport.ts:80 sanitizeProxyUrl
 * - src/http/endpoint/provider/impl/proxyEndpointProvider.ts:61 sanitizeProxyUrl
 * - src/http/endpoint/proxy/httpProxyUrlParser.ts:49 sanitizeProxyUrl
 * - src/http/httpClient.ts:321 sanitizeHttpUrl
 * - src/retry/fetchOperation.ts:251 sanitizedUrl
 * - src/api/api.ts:270 safeApiUrl
 * - src/http/responseBody.ts:72 safeHttpUrl
 * - src/http/endpoint/endpointFactory.ts:154 sanitizeEndpointUrl
 */

/**
 * Strips `user:password@` from the authority of a URL string without
 * normalizing anything else. Falls back to the raw string when the URL
 * cannot be parsed, still removing anything that looks like userinfo.
 */
export function stripUserInfo(value: string): string {
    if (!value.includes('@')) {
        return value;
    }

    try {
        const url = new URL(value);

        if (url.username === '' && url.password === '') {
            return value;
        }
    } catch {
        // Fall through to the conservative regex below.
    }

    return value.replace(/\/\/[^@/?#]+@/, '//');
}

/**
 * Removes credentials, query params and fragments from an HTTP URL.
 * Used for API / fetch error messages and logs.
 * Returns '<invalid URL>' for unparseable input.
 */
export function sanitizeHttpUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return '<invalid URL>';
    }
}

/**
 * Keeps only protocol + hostname + port for proxy URLs.
 * Strips credentials, path, query and fragment.
 * Returns '<invalid proxy URL>' for unparseable input.
 */
export function sanitizeProxyUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return '<invalid proxy URL>';
    }
}

/**
 * Keeps only protocol + hostname + port for endpoint URLs.
 * Returns '<invalid endpoint URL>' for unparseable input.
 */
export function sanitizeEndpointUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return '<invalid endpoint URL>';
    }
}
