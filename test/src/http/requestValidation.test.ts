import { describe, expect, it } from '@jest/globals';
import { TrialValidationError } from '../../../src/error/errors.js';
import { validateFetchJsonRequestOptions } from '../../../src/http/requestValidation.js';

describe('validateFetchJsonRequestOptions', () => {
    describe('requestAbortTimeoutMs', () => {
        it.each([
            ['zero', 0],
            ['negative integer', -1],
            ['decimal', 1.5],
            ['NaN', NaN],
            ['Infinity', Infinity],
            ['negative Infinity', -Infinity],
            ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
        ])('rejects %s', (_, requestAbortTimeoutMs) => {
            expect(() =>
                validateFetchJsonRequestOptions({
                    requestAbortTimeoutMs,
                }),
            ).toThrow(TrialValidationError);
        });

        it.each([1, 50, 1_000, Number.MAX_SAFE_INTEGER])('accepts positive safe integer %s', (requestAbortTimeoutMs) => {
            expect(() =>
                validateFetchJsonRequestOptions({
                    requestAbortTimeoutMs,
                }),
            ).not.toThrow();
        });
    });

    it('throws TrialValidationError for invalid maxRetries', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                maxRetries: -1,
            }),
        ).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for invalid retryOnTimeout', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                retryPolicy: {
                    retryOnTimeout: 'yes' as unknown as boolean,
                },
            }),
        ).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for invalid baseDelayMs', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                retryPolicy: {
                    baseDelayMs: 0,
                },
            }),
        ).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for invalid backoffCapMs', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                retryPolicy: {
                    backoffCapMs: 0,
                },
            }),
        ).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError when retryableStatusCodes contains 404', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                retryPolicy: {
                    retryableStatusCodes: new Set([404]),
                },
            }),
        ).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for invalid retryable status code', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                retryPolicy: {
                    retryableStatusCodes: new Set([99]),
                },
            }),
        ).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for invalid retryOnNetworkError', () => {
        expect(() =>
            validateFetchJsonRequestOptions({
                retryPolicy: {
                    retryOnNetworkError: 'yes' as unknown as boolean,
                },
            }),
        ).toThrow(TrialValidationError);
    });
});
