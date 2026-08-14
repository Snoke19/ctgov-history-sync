import type { HttpClientOptions } from '../../types/http.js';
import { TokenBucket } from '../impl/tokenBucket.js';
import { UnlimitedLimiter } from '../impl/unlimitedLimiter.js';
import type { Limiter } from '../limiter.js';
import { LimiterFactory } from './limiterFactory.js';

export class DefaultLimiterFactory implements LimiterFactory {
    create(options: HttpClientOptions): Limiter {
        if (!options.useRateLimit) {
            return new UnlimitedLimiter();
        }

        return new TokenBucket(
            options.rateLimitCapacity,
            options.rateLimitWindow,
            options.monotonicClock?.now,
            options.sleep,
        );
    }
}
