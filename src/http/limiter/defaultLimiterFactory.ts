import { assertPositiveInt } from '../../utils/validation.js';
import type { HttpClientOptions } from '../types/http.js';
import { TokenBucket } from './tokenBucket.js';
import { UnlimitedLimiter } from './unlimitedLimiter.js';
import type { Limiter } from './limiter.js';
import { LimiterFactory } from './limiterFactory.js';

/**
 * Selects between {@link TokenBucket} and {@link UnlimitedLimiter} based on
 * the `useRateLimit` flag in {@link HttpClientOptions}.
 *
 * Previously this logic lived as a private method of EndpointFactory, which
 * forced any test covering a new limiter type to modify that class.
 * Moving it here makes it independently testable and open for extension.
 */
export class DefaultLimiterFactory implements LimiterFactory {
    create(options: HttpClientOptions): Limiter {
        if (!options.useRateLimit) {
            return new UnlimitedLimiter();
        }

        assertPositiveInt(options.rateLimitCapacity, 'rateLimitCapacity');
        assertPositiveInt(options.rateLimitWindow, 'rateLimitWindow');

        return new TokenBucket(options.rateLimitCapacity, options.rateLimitWindow);
    }
}
