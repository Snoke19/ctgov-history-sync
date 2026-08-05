import { TokenBucket } from '../limiter/tokenBucket.js';
import { UnlimitedLimiter } from '../limiter/unlimitedLimiter.js';
import { DirectEndpoint } from './direct/directEndpoint.js';
import { createProxyEndpoints } from './proxy/proxyEndpoints.js';
import { ProxyEndpointFactory } from './proxy/proxyEndpointFactory.js';
import { assertPositiveInt } from '../../utils/validation.js';
import { ConfigurationError } from '../../error/errors.js';
import type { HttpClientOptions } from '../types/http.js';
import type { Endpoint } from './endpoint.js';
import type { Limiter } from '../limiter/limiter.js';

/**
 * Builds the concrete {@link Endpoint} list from {@link HttpClientOptions}.
 *
 * Responsibilities:
 *   - Validate rate-limit and proxy configuration fields
 *   - Wire the correct {@link Limiter} implementation for each endpoint
 *   - Construct proxy or direct endpoints as indicated by options
 *
 * Keeping this logic here (rather than in the EndpointManager constructor)
 * allows EndpointManager to be tested with injected endpoints,
 * and EndpointFactory independently of the acquire/release loop.
 */
export class EndpointFactory {
    /**
     * @param proxyEndpointFactory - Injected for testing or alternative
     *   transport implementations. Defaults to {@link ProxyEndpointFactory},
     *   which expects a {@link TransportFactory} (e.g., {@link UndiciTransportFactory}).
     */
    constructor(private readonly proxyEndpointFactory: ProxyEndpointFactory) {}

    build(options: HttpClientOptions): Endpoint[] {
        const createLimiter = this.buildLimiterFactory(options);
        return options.useProxy
            ? this.buildProxyEndpoints(options, createLimiter)
            : [new DirectEndpoint(createLimiter())];
    }

    private buildLimiterFactory(options: HttpClientOptions): () => Limiter {
        if (!options.useRateLimit) {
            return () => new UnlimitedLimiter();
        }

        assertPositiveInt(options.rateLimitCapacity, 'rateLimitCapacity');
        assertPositiveInt(options.rateLimitWindow, 'rateLimitWindow');

        return () => new TokenBucket(options.rateLimitCapacity, options.rateLimitWindow);
    }

    private buildProxyEndpoints(
        options: HttpClientOptions,
        createLimiter: () => Limiter,
    ): Endpoint[] {
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
            this.proxyEndpointFactory,
        );

        if (endpoints.length === 0) {
            throw new ConfigurationError(
                'useProxy is enabled, but no valid proxy URLs were configured.',
            );
        }

        return endpoints;
    }
}
