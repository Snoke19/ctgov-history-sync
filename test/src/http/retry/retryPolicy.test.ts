import { describe, expect, it } from '@jest/globals';
import { BACKOFF_CAP_MS, RETRY_BASE_DELAY_MS } from '../../../../src/config/config.js';
import {
    HttpException,
    NetworkException,
    TimeoutException,
    TrialError,
} from '../../../../src/error/errors.js';
import {
    calculateBackoff,
    defaultRetryPolicyConfig,
    parseRetryAfterHeader,
    RetryPolicyConfig,
    shouldRetry,
} from '../../../../src/http/retry/retryPolicy.js';

describe('shouldRetry', () => {
    const baseConfig: RetryPolicyConfig = {
        retryOnTimeout: true,
        retryOnNetworkError: true,
        retryableStatusCodes: new Set([429, 500, 502, 503, 504]),
    };

    describe('TimeoutException', () => {
        it('returns true when retryOnTimeout is enabled', () => {
            expect(shouldRetry(new TimeoutException('timeout'), 'GET', baseConfig)).toBe(true);
        });

        it('returns false when retryOnTimeout is disabled', () => {
            const config: RetryPolicyConfig = { ...baseConfig, retryOnTimeout: false };
            expect(shouldRetry(new TimeoutException('timeout'), 'GET', config)).toBe(false);
        });
    });

    describe('NetworkException', () => {
        it('returns true when retryOnNetworkError is enabled', () => {
            expect(shouldRetry(new NetworkException('econnreset'), 'GET', baseConfig)).toBe(true);
        });

        it('returns false when retryOnNetworkError is disabled', () => {
            const config: RetryPolicyConfig = { ...baseConfig, retryOnNetworkError: false };
            expect(shouldRetry(new NetworkException('econnreset'), 'GET', config)).toBe(false);
        });
    });

    describe('HttpException', () => {
        it('does not retry status codes outside the retryable set', () => {
            const error = new HttpException('bad request', 400);
            expect(shouldRetry(error, 'GET', baseConfig)).toBe(false);
        });

        it('retries 429 without checking idempotency', () => {
            const error = new HttpException('too many requests', 429);
            expect(shouldRetry(error, 'POST', baseConfig, false)).toBe(true);
        });

        it('retries 5xx for idempotent methods', () => {
            const error = new HttpException('server error', 500);
            expect(shouldRetry(error, 'GET', baseConfig)).toBe(true);
            expect(shouldRetry(error, 'PUT', baseConfig)).toBe(true);
            expect(shouldRetry(error, 'POST', baseConfig, true)).toBe(true);
        });

        it('does not retry 5xx for non-idempotent methods', () => {
            const error = new HttpException('server error', 500);
            expect(shouldRetry(error, 'POST', baseConfig)).toBe(false);
            expect(shouldRetry(error, 'POST', baseConfig, false)).toBe(false);
        });

        it('retries 502/503/504 only for idempotent methods', () => {
            [502, 503, 504].forEach((status) => {
                const error = new HttpException('gateway error', status);
                expect(shouldRetry(error, 'DELETE', baseConfig)).toBe(true);
                expect(shouldRetry(error, 'POST', baseConfig)).toBe(false);
            });
        });
    });

    describe('unknown TrialError', () => {
        it('never retries', () => {
            const error = new TrialError('something weird');
            expect(shouldRetry(error, 'GET', baseConfig)).toBe(false);
        });
    });

    describe('defaultRetryPolicyConfig', () => {
        it('is exported and populated from env defaults', () => {
            expect(defaultRetryPolicyConfig).toBeDefined();
            expect(typeof defaultRetryPolicyConfig.retryOnTimeout).toBe('boolean');
            expect(defaultRetryPolicyConfig.retryableStatusCodes instanceof Set).toBe(true);
        });
    });
});

describe('calculateBackoff', () => {
    it('returns exponential backoff for first retry (attempt 0)', () => {
        const backoff = calculateBackoff(0, null, () => 0);
        expect(backoff).toBe(RETRY_BASE_DELAY_MS);
    });

    it('doubles the base delay for each subsequent retry', () => {
        const attempt0 = calculateBackoff(0, null, () => 0);
        const attempt1 = calculateBackoff(1, null, () => 0);
        const attempt2 = calculateBackoff(2, null, () => 0);

        expect(attempt1).toBe(attempt0 * 2);
        expect(attempt2).toBe(attempt0 * 4);
    });

    it('adds up to 50% random jitter', () => {
        const withoutJitter = calculateBackoff(0, null, () => 0);
        const withMaxJitter = calculateBackoff(0, null, () => 1);

        expect(withoutJitter).toBe(RETRY_BASE_DELAY_MS);
        expect(withMaxJitter).toBe(RETRY_BASE_DELAY_MS + RETRY_BASE_DELAY_MS * 0.5);
    });

    it('caps backoff at BACKOFF_CAP_MS', () => {
        const backoff = calculateBackoff(20, null, () => 0);
        expect(backoff).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    });

    it('honors Retry-After header value', () => {
        const backoff = calculateBackoff(0, 2000);
        expect(backoff).toBe(2000);
    });

    it('caps Retry-After at BACKOFF_CAP_MS', () => {
        const hugeRetryAfter = 86_400_000; // 24 hours
        const backoff = calculateBackoff(0, hugeRetryAfter);
        expect(backoff).toBe(BACKOFF_CAP_MS);
    });

    it('falls back to exponential backoff when Retry-After is null', () => {
        const backoff = calculateBackoff(0, null, () => 0);
        expect(backoff).toBe(RETRY_BASE_DELAY_MS);
    });

    it('falls back to exponential backoff when Retry-After is 0', () => {
        const backoff = calculateBackoff(0, 0, () => 0);
        expect(backoff).toBe(RETRY_BASE_DELAY_MS);
    });

    it('falls back to exponential backoff when Retry-After is negative', () => {
        const backoff = calculateBackoff(0, -1000, () => 0);
        expect(backoff).toBe(RETRY_BASE_DELAY_MS);
    });
});

describe('parseRetryAfterHeader', () => {
    function makeResponse(headers: Record<string, string>) {
        return {
            headers: {
                get: (name: string) => headers[name] ?? null,
            },
        } as any;
    }

    it('returns null when header is absent', () => {
        expect(parseRetryAfterHeader(makeResponse({}))).toBeNull();
    });

    it('parses delay-seconds format', () => {
        const result = parseRetryAfterHeader(makeResponse({ 'Retry-After': '5' }));
        expect(result).toBe(5000);
    });

    it('parses HTTP-date format', () => {
        const futureMs = Date.now() + 3000;
        const dateStr = new Date(futureMs).toUTCString();
        const result = parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }));
        expect(result).toBeGreaterThanOrEqual(2000);
        expect(result).toBeLessThanOrEqual(4000);
    });

    it('returns 0 for a past HTTP-date', () => {
        const pastStr = new Date(0).toUTCString();
        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': pastStr }))).toBe(0);
    });

    it('returns null for unparsable values', () => {
        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'garbage' }))).toBeNull();
    });
});
