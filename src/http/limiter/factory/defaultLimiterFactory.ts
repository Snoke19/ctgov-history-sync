import { createLogger } from '../../../config/logging.js';
import { defaultMonotonicClock, MonotonicClock, Sleeper } from '../../clock.js';
import { TokenBucket } from '../impl/tokenBucket.js';
import { UnlimitedLimiter } from '../impl/unlimitedLimiter.js';
import type { Limiter } from '../limiter.js';
import { LimiterFactory } from './limiterFactory.js';

const logger = createLogger(import.meta.url);

export interface DefaultLimiterFactoryOptions {
    readonly enabled: boolean;
    readonly capacity: number;
    readonly windowMs: number;
    readonly clock?: MonotonicClock['now'] | undefined;
    readonly sleep?: Sleeper['sleep'] | undefined;
}

export class DefaultLimiterFactory implements LimiterFactory {
    constructor(private readonly options: DefaultLimiterFactoryOptions) {}

    create(): Limiter {
        if (!this.options.enabled) {
            logger.debug({ limiterType: 'unlimited' }, 'Rate limiter created');

            return new UnlimitedLimiter();
        }

        logger.debug(
            { limiterType: 'token-bucket', capacity: this.options.capacity, windowMs: this.options.windowMs },
            'Rate limiter created',
        );

        return new TokenBucket({
            capacity: this.options.capacity,
            windowMs: this.options.windowMs,
            clock: this.options.clock ?? defaultMonotonicClock.now,
            sleep: this.options.sleep,
        });
    }
}
