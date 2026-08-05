import { ConfigurationError } from '../../../error/errors.js';
import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import type { Endpoint } from '../endpoint.js';
import type { EndpointProvider } from '../types/endpointProvider.js';
import { createProxyEndpoints } from './proxyEndpoints.js';
import { ProxyEndpointFactory } from './proxyEndpointFactory.js';

/**
 * Creates ProxyEndpoints — requests go through a proxy.
 *
 * To use SOCKS instead of an HTTP proxy, pass
 * `ProxyEndpointFactory` with `SocksTransportFactory`.
 */
export class ProxyEndpointProvider implements EndpointProvider {
    constructor(private readonly proxyFactory: ProxyEndpointFactory) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        if (typeof options.proxyUrls !== 'string' || options.proxyUrls.trim() === '') {
            throw new ConfigurationError(
                'proxyUrls must be a non-empty string when useProxy is enabled.',
            );
        }

        if (!options.poolConfig) {
            throw new ConfigurationError('poolConfig is required when useProxy is enabled.');
        }

        const endpoints = createProxyEndpoints(
            options.proxyUrls,
            createLimiter,
            options.concurrency,
            options.poolConfig,
            options.proxyType,
            this.proxyFactory,
        );

        if (endpoints.length === 0) {
            throw new ConfigurationError(
                'useProxy is enabled, but no valid proxy URLs were configured.',
            );
        }

        return endpoints;
    }
}
