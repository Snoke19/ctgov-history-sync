import type { HttpClientOptions } from '../types/http.js';
import type { Endpoint } from './endpoint.js';
import type { Limiter } from '../limiter/limiter.js';
import { LimiterFactory } from '../limiter/factory/limiterFactory.js';
import { EndpointProvider } from './provider/endpointProvider.js';

/**
 * Builds the concrete {@link Endpoint} list from {@link HttpClientOptions}.
 *
 * Responsibilities:
 *   - Wire the correct {@link Limiter} for each endpoint via {@link LimiterFactory}.
 *   - Delegate endpoint construction to the injected {@link EndpointProvider}.
 *
 * Rate-limit validation now lives inside the {@link LimiterFactory} implementation,
 * keeping this class focused solely on endpoint construction.
 *
 * The separation of this class from {@link EndpointManager} allows both to be
 * tested independently: EndpointFactory with various provider/limiter stubs,
 * and EndpointManager with pre-built endpoint stubs.
 */
export class EndpointFactory {
    constructor(
        private readonly provider: EndpointProvider,
        private readonly limiterFactory: LimiterFactory,
    ) {}

    build(options: HttpClientOptions): Endpoint[] {
        const createLimiter = (): Limiter => this.limiterFactory.create(options);
        return this.provider.build(options, createLimiter);
    }
}
