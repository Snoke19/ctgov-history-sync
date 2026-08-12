import { describe, expect, it } from '@jest/globals';
import { TokenBucket } from '../src/http/limiter/impl/tokenBucket.js';

describe('TokenBucket', () => {
    it('allows immediate tokens and refills over time', () => {
        let now = 0;
        const clock = () => now;
        const sleep = async (ms: number) => {
            // advance clock deterministically
            now += ms;
        };

        const capacity = 4;
        const windowMs = 4000; // 4s window => 1000ms per token
        const tb = new TokenBucket(capacity, windowMs, clock, sleep);

        // starts full
        expect(tb.peekTokens()).toBe(capacity);

        // consume all tokens
        expect(tb.tryAcquire()).toBe(true);
        expect(tb.tryAcquire()).toBe(true);
        expect(tb.tryAcquire()).toBe(true);
        expect(tb.tryAcquire()).toBe(true);
        expect(tb.tryAcquire()).toBe(false);

        // after 500ms no token yet
        now += 500;
        expect(tb.peekTokens()).toBe(0);

        // after 1000ms, one token available
        now += 500;
        expect(tb.peekTokens()).toBe(1);
    });

    it('acquire waits until token or times out', async () => {
        let now = 0;
        const clock = () => now;
        const sleep = async (ms: number) => {
            now += ms;
        };

        const tb = new TokenBucket(1, 1000, clock, sleep);

        // consume the only token
        expect(tb.tryAcquire()).toBe(true);
        const start = now;

        // acquire with timeout shorter than refill should throw
        await expect(tb.acquire(500)).rejects.toThrow();

        // acquire with sufficient timeout should succeed
        now = start; // reset
        const p = tb.acquire(1500);
        // since our sleep advances the clock, awaiting should resolve
        await expect(p).resolves.toBeUndefined();
    });
});
