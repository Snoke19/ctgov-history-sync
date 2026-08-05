import { TokenBucket } from '../limiter/tokenBucket.js';
import { UnlimitedLimiter } from '../limiter/unlimitedLimiter.js';
import { assertPositiveInt } from '../../utils/validation.js';
import type { HttpClientOptions } from '../types/http.js';
import type { Endpoint } from './endpoint.js';
import type { Limiter } from '../limiter/limiter.js';
import { EndpointProvider } from './types/endpointProvider.js';

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
    constructor(private readonly provider: EndpointProvider) {}

    build(options: HttpClientOptions): Endpoint[] {
        const createLimiter = this.buildLimiterFactory(options);
        return this.provider.build(options, createLimiter);
    }

    private buildLimiterFactory(options: HttpClientOptions): () => Limiter {
        if (!options.useRateLimit) {
            return () => new UnlimitedLimiter();
        }

        assertPositiveInt(options.rateLimitCapacity, 'rateLimitCapacity');
        assertPositiveInt(options.rateLimitWindow, 'rateLimitWindow');

        return () => new TokenBucket(options.rateLimitCapacity, options.rateLimitWindow);
    }
}
