import { describe, expect, it } from '@jest/globals';
import { HttpException, NetworkException, TimeoutException, TrialError } from '../../../../src/error/errors.js';
import { HttpResponse } from '../../../../src/http/endpoint/transport/httpTransport.js';
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
            expect(typeof defaultRetryPolicyConfig.baseDelayMs).toBe('number');
            expect(typeof defaultRetryPolicyConfig.backoffCapMs).toBe('number');
        });
    });
});

describe('calculateBackoff', () => {
    // Explicit, test-local timing constants. Backoff assertions must never
    // read RETRY_BASE_DELAY_MS / BACKOFF_CAP_MS from config: an .env.test
    // edit would otherwise silently rewrite what these tests assert.
    const BASE = 1000;
    const CAP = 30000;

    const noJitter = { random: () => 0, baseDelayMs: BASE, backoffCapMs: CAP };

    it('returns exponential backoff for first retry (attempt 0)', () => {
        const backoff = calculateBackoff(0, null, noJitter);
        expect(backoff).toBe(BASE);
    });

    it('doubles the base delay for each subsequent retry', () => {
        const attempt0 = calculateBackoff(0, null, noJitter);
        const attempt1 = calculateBackoff(1, null, noJitter);
        const attempt2 = calculateBackoff(2, null, noJitter);

        expect(attempt1).toBe(attempt0 * 2);
        expect(attempt2).toBe(attempt0 * 4);
    });

    it('adds up to 50% random jitter', () => {
        const withoutJitter = calculateBackoff(0, null, { ...noJitter, random: () => 0 });
        const withMaxJitter = calculateBackoff(0, null, { ...noJitter, random: () => 1 });

        expect(withoutJitter).toBe(BASE);
        expect(withMaxJitter).toBe(BASE + BASE * 0.5);
    });

    it('caps backoff at the configured cap', () => {
        const backoff = calculateBackoff(20, null, noJitter);
        expect(backoff).toBe(CAP);
    });

    it('honors Retry-After header value', () => {
        const backoff = calculateBackoff(0, 2000, { ...noJitter });
        expect(backoff).toBe(2000);
    });

    it('caps Retry-After at the configured cap', () => {
        const hugeRetryAfter = 86_400_000; // 24 hours
        const backoff = calculateBackoff(0, hugeRetryAfter, noJitter);
        expect(backoff).toBe(CAP);
    });

    it('falls back to exponential backoff when Retry-After is null', () => {
        const backoff = calculateBackoff(0, null, noJitter);
        expect(backoff).toBe(BASE);
    });

    it('falls back to exponential backoff when Retry-After is 0', () => {
        const backoff = calculateBackoff(0, 0, noJitter);
        expect(backoff).toBe(BASE);
    });

    it('falls back to exponential backoff when Retry-After is negative', () => {
        const backoff = calculateBackoff(0, -1000, noJitter);
        expect(backoff).toBe(BASE);
    });
});

describe('parseRetryAfterHeader', () => {
    function makeResponse(headers: Record<string, string>) {
        return {
            headers: {
                get: (name: string) => headers[name] ?? null,
            },
        } as unknown as HttpResponse;
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
