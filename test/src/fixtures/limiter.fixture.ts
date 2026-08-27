import { jest } from '@jest/globals';
import { DefaultLimiterFactory } from '../../../src/http/limiter/factory/defaultLimiterFactory.js';
import type { LimiterFactory } from '../../../src/http/limiter/factory/limiterFactory.js';
import type { Limiter } from '../../../src/http/limiter/limiter.js';

export function createMockLimiter(overrides: Partial<jest.Mocked<Limiter>> = {}): jest.Mocked<Limiter> {
    return {
        tryAcquire: jest.fn<(now: number) => boolean>().mockReturnValue(true),
        timeUntilToken: jest.fn<(now: number) => number>().mockReturnValue(0),
        ...overrides,
    };
}

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
