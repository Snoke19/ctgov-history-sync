import { describe, expect, it } from '@jest/globals';
import { calculateBackoff, parseRetryAfterHeader, shouldRetry } from '../src/http/retry/retryPolicy.js';
import { HttpException, TimeoutException, NetworkException } from '../src/error/errors.js';

describe('retryPolicy', () => {
    it('calculateBackoff uses retryAfter when present', () => {
        const backoff = calculateBackoff(0, 2000, () => 0.5);
        expect(backoff).toBe(2000);
    });

    it('calculateBackoff uses exponential backoff with jitter', () => {
        const b0 = calculateBackoff(0, null, () => 0);
        const b1 = calculateBackoff(1, null, () => 0);
        expect(b1).toBeGreaterThanOrEqual(b0 * 2 - 1);
    });

    it('parseRetryAfterHeader supports seconds and date', () => {
        const headers = new Map<string, string>([['Retry-After', '2']]);
        const resp = { headers: { get: (k: string) => headers.get(k) } } as any;
        const v = parseRetryAfterHeader(resp as any);
        expect(v).toBe(2000);

        const date = new Date(Date.now() + 3000).toUTCString();
        const resp2 = { headers: { get: () => date } } as any;
        const v2 = parseRetryAfterHeader(resp2 as any);
        expect(v2).toBeGreaterThanOrEqual(0);
    });

    it('shouldRetry returns false for unknown error', () => {
        // @ts-ignore - pass a generic Error
        expect(shouldRetry(new Error('x') as any, 'GET', { retryOnTimeout: false, retryOnNetworkError: false, retryableStatusCodes: new Set() })).toBe(false);
    });

    it('shouldRetry respects HttpException status', () => {
        const ex = new HttpException('msg', 500);
        expect(shouldRetry(ex, 'GET', { retryOnTimeout: false, retryOnNetworkError: false, retryableStatusCodes: new Set([500]) })).toBe(true);
    });
});
