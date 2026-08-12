import { LimiterFactory } from '../limiter/factory/limiterFactory.js';
import type { Limiter } from '../limiter/limiter.js';
import type { HttpClientOptions } from '../types/http.js';
import type { Endpoint } from './endpoint.js';
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
