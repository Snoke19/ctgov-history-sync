import type { HttpClientOptions } from '../types/http.js';
import type { Limiter } from './limiter.js';

/**
 * Strategy for creating a {@link Limiter} from the current HTTP client options.
 *
 * Decouples {@link EndpointFactory} from concrete limiter types (TokenBucket,
 * SlidingWindow, distributed, etc.) so new implementations can be added
 * without touching the endpoint construction pipeline.
 *
 * To add a new limiter:
 *   1. Implement this interface.
 *   2. Inject it into {@link EndpointFactory} at the composition root.
 */
export interface LimiterFactory {
    create(options: HttpClientOptions): Limiter;
}
