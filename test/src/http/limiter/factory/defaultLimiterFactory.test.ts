import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TokenBucketOptions } from '../../../../../src/http/limiter/impl/tokenBucket.js';
import { UnlimitedLimiter } from '../../../../../src/http/limiter/impl/unlimitedLimiter.js';

const mockTokenBucket = jest.fn<(options: TokenBucketOptions) => unknown>();

jest.unstable_mockModule('../../../../../src/http/limiter/impl/tokenBucket.js', () => ({
    TokenBucket: mockTokenBucket,
}));

const { DefaultLimiterFactory } = await import('../../../../../src/http/limiter/factory/defaultLimiterFactory.js');

describe('DefaultLimiterFactory', () => {
    beforeEach(() => {
        mockTokenBucket.mockReset();
        mockTokenBucket.mockImplementation(() => ({}));
    });

    it('creates an UnlimitedLimiter when rate limiting is disabled', () => {
        const factory = new DefaultLimiterFactory({ enabled: false, capacity: 10, windowMs: 1000 });

        const limiter = factory.create();

        expect(limiter).toBeInstanceOf(UnlimitedLimiter);
        expect(mockTokenBucket).not.toHaveBeenCalled();
    });

    it('creates a TokenBucket with the configured settings when enabled', () => {
        const clock = () => 0;
        const sleep = async () => {};
        const factory = new DefaultLimiterFactory({ enabled: true, capacity: 10, windowMs: 1000, clock, sleep });

        factory.create();

        expect(mockTokenBucket).toHaveBeenCalledWith({ capacity: 10, windowMs: 1000, clock, sleep });
    });

    it('falls back to the default clock when none is provided', () => {
        const factory = new DefaultLimiterFactory({ enabled: true, capacity: 10, windowMs: 1000 });

        factory.create();

        const options = mockTokenBucket.mock.calls[0]![0];
        expect(options.capacity).toBe(10);
        expect(options.windowMs).toBe(1000);
        expect(options.clock).toBeDefined();
        expect(options.sleep).toBeUndefined();
    });

    it('create() takes no arguments — the factory owns its configuration', () => {
        const factory = new DefaultLimiterFactory({ enabled: false, capacity: 10, windowMs: 1000 });

        expect(() => factory.create()).not.toThrow();
    });
});
