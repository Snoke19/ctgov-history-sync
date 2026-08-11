import { describe, expect, it } from '@jest/globals';
import { defaultRetryPolicyConfig, RetryPolicyConfig, shouldRetry } from '../../../../src/http/retry/retryPolicy.js';
import { HttpException, NetworkException, TimeoutException } from '../../../../src/http/retry/exceptions.js';
import { BusinessException } from '../../../../src/http/retry/businessException.js';

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

    describe('unknown BusinessException', () => {
        it('never retries', () => {
            const error = new BusinessException('something weird');
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
