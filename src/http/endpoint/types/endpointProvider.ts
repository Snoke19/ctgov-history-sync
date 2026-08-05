import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import type { Endpoint } from '../endpoint.js';

/**
 * Endpoint creation strategy.
 *
 * Each implementation knows how to build a list of endpoints
 * for a specific data retrieval method (direct, proxy, socks).
 */
export interface EndpointProvider {
    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[];
}
