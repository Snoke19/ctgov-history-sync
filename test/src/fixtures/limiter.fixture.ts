import { DefaultLimiterFactory } from '../../../src/http/limiter/factory/defaultLimiterFactory.js';
import type { LimiterFactory } from '../../../src/http/limiter/factory/limiterFactory.js';

export function createDisabledLimiterFactory(): LimiterFactory {
    return new DefaultLimiterFactory({
        enabled: false,
        capacity: 1,
        windowMs: 1000,
    });
}

export function createEnabledLimiterFactory(
    clock: () => number,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): LimiterFactory {
    return new DefaultLimiterFactory({
        enabled: true,
        capacity: 1,
        windowMs: 100,

        clock,
        sleep,
    });
}
