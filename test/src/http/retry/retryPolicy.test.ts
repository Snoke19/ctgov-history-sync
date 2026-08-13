import { describe, expect, it } from '@jest/globals';
import { HttpException, NetworkException, TimeoutException, TrialError } from '../../../../src/error/errors.js';
import {
    calculateBackoff,
    defaultRetryPolicyConfig,
    parseRetryAfterHeader,
    RetryPolicyConfig,
    shouldRetry,
} from '../../../../src/http/retry/retryPolicy.js';
import { HttpResponse } from '../../../../src/http/transport/httpTransport.js';

describe('defaultRetryPolicyConfig', () => {
    it('contains the configured retry defaults', () => {
        expect(defaultRetryPolicyConfig.retryOnTimeout).toBe(true);
        expect(defaultRetryPolicyConfig.retryOnNetworkError).toBe(true);
        expect(defaultRetryPolicyConfig.retryableStatusCodes).toEqual(new Set([408, 429, 500, 502, 503, 504]));
        expect(defaultRetryPolicyConfig.baseDelayMs).toBeGreaterThan(0);
        expect(defaultRetryPolicyConfig.backoffCapMs).toBeGreaterThan(0);
    });
});

describe('shouldRetry', () => {
    const baseConfig: RetryPolicyConfig = {
        retryOnTimeout: true,
        retryOnNetworkError: true,
        retryableStatusCodes: new Set([408, 429, 500, 502, 503, 504]),
    };

    describe('TimeoutException', () => {
        it('returns true when retryOnTimeout is enabled', () => {
            expect(shouldRetry(new TimeoutException('timeout'), baseConfig)).toBe(true);
        });

        it('returns false when retryOnTimeout is disabled', () => {
            const config: RetryPolicyConfig = {
                ...baseConfig,
                retryOnTimeout: false,
            };

            expect(shouldRetry(new TimeoutException('timeout'), config)).toBe(false);
        });
    });

    describe('NetworkException', () => {
        it('returns true when retryOnNetworkError is enabled', () => {
            expect(shouldRetry(new NetworkException('econnreset'), baseConfig)).toBe(true);
        });

        it('returns false when retryOnNetworkError is disabled', () => {
            const config: RetryPolicyConfig = {
                ...baseConfig,
                retryOnNetworkError: false,
            };

            expect(shouldRetry(new NetworkException('econnreset'), config)).toBe(false);
        });
    });

    describe('HttpException', () => {
        it.each([408, 429, 500, 502, 503, 504])('returns true for retryable status %s', (status) => {
            expect(shouldRetry(new HttpException('retryable error', status), baseConfig)).toBe(true);
        });

        it.each([400, 401, 403, 404])('returns false for non-retryable status %s', (status) => {
            expect(shouldRetry(new HttpException('non-retryable error', status), baseConfig)).toBe(false);
        });
    });

    describe('unknown TrialError', () => {
        it('never retries', () => {
            const error = new TrialError('something weird');

            expect(shouldRetry(error, baseConfig)).toBe(false);
        });
    });
});

describe('calculateBackoff', () => {
    const BASE = 1000;
    const CAP = 30000;

    const noJitter = { random: () => 0, baseDelayMs: BASE, backoffCapMs: CAP };

    it('never exceeds the backoff cap even with maximum jitter', () => {
        const backoff = calculateBackoff(10, null, {
            random: () => 1,
            baseDelayMs: BASE,
            backoffCapMs: CAP,
        });

        expect(backoff).toBe(CAP);
    });

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

    it('returns null for invalid numeric Retry-After values', () => {
        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'Infinity' }))).toBeNull();
        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '-1' }))).toBeNull();
        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '1.5' }))).toBeNull();
    });

    it('returns null when header is absent', () => {
        expect(parseRetryAfterHeader(makeResponse({}))).toBeNull();
    });

    it('parses delay-seconds format', () => {
        const result = parseRetryAfterHeader(makeResponse({ 'Retry-After': '5' }));
        expect(result).toBe(5000);
    });

    it('parses HTTP-date format', () => {
        const now = Date.parse('2026-08-13T00:00:00Z');
        const dateStr = new Date(now + 3000).toUTCString();

        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }), now)).toBe(3000);
    });

    it('returns 0 for a past HTTP-date', () => {
        const now = Date.parse('2026-08-13T00:00:00Z');
        const past = new Date(now - 3000).toUTCString();

        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': past }), now)).toBe(0);
    });

    it('returns null for unparsable values', () => {
        expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'garbage' }))).toBeNull();
    });
});
