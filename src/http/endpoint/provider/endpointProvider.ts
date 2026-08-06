import { Limiter } from '../../limiter/limiter.js';
import { HttpClientOptions } from '../../types/http.js';
import { Endpoint } from '../endpoint.js';

/**
 * Endpoint creation strategy.
 *
 * Each implementation knows how to build a list of endpoints
 * for a specific data retrieval method (direct, proxy, socks).
 */
export interface EndpointProvider {
    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[];
}
