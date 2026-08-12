import { describe, expect, it } from '@jest/globals';
import {
    CallerAbortedError,
    ConfigurationError,
    EndpointAcquisitionTimeoutError,
    HttpException,
    NetworkException,
    TimeoutException,
    TokenBucketTimeoutError,
    TrialError,
    TrialFetchError,
    TrialNotFoundError,
    TrialValidationError,
} from '../../../src/error/errors.js';

describe('error classes', () => {
    describe('TrialError', () => {
        it('sets the TrialError name and message', () => {
            const err = new TrialError('boom');
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe('TrialError');
            expect(err.message).toBe('boom');
        });

        it('attaches the cause when provided', () => {
            const cause = new Error('root cause');
            const err = new TrialError('boom', { cause });
            expect(err.cause).toBe(cause);
        });

        it('leaves cause undefined when not provided', () => {
            expect(new TrialError('boom').cause).toBeUndefined();
        });
    });

    describe('ConfigurationError', () => {
        it('is a TrialError named ConfigurationError', () => {
            const err = new ConfigurationError('bad config');
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('ConfigurationError');
            expect(err.message).toBe('bad config');
        });
    });

    describe('TrialNotFoundError', () => {
        it('stores the code and formats the message', () => {
            const err = new TrialNotFoundError('NCT00000001');
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('TrialNotFoundError');
            expect(err.code).toBe('NCT00000001');
            expect(err.message).toBe('Trial not found: NCT00000001');
        });
    });

    describe('TrialFetchError', () => {
        it('stores url, status, isTransient, and cause', () => {
            const cause = new Error('parse failed');
            const err = new TrialFetchError('https://api.test/x', cause, 200, false);
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('TrialFetchError');
            expect(err.url).toBe('https://api.test/x');
            expect(err.status).toBe(200);
            expect(err.isTransient).toBe(false);
            expect(err.cause).toBe(cause);
            expect(err.message).toBe('Failed to fetch: https://api.test/x');
        });

        it('defaults status to null and isTransient to false', () => {
            const err = new TrialFetchError('https://api.test/x');
            expect(err.status).toBeNull();
            expect(err.isTransient).toBe(false);
        });

        it('records explicit transient flag', () => {
            const err = new TrialFetchError('https://api.test/x', new Error('nope'), 429, true);
            expect(err.isTransient).toBe(true);
        });
    });

    describe('HttpException', () => {
        it('stores status and optional retryAfterMs', () => {
            const err = new HttpException('rate limited', 429, 1000);
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('HttpException');
            expect(err.status).toBe(429);
            expect(err.retryAfterMs).toBe(1000);
        });

        it('leaves retryAfterMs undefined when omitted', () => {
            const err = new HttpException('gone', 404);
            expect(err.retryAfterMs).toBeUndefined();
        });
    });

    describe('NetworkException', () => {
        it('is a TrialError carrying the transport cause', () => {
            const cause = new TypeError('ECONNRESET');
            const err = new NetworkException('network failure', cause);
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('NetworkException');
            expect(err.message).toBe('network failure');
            expect(err.cause).toBe(cause);
        });
    });

    describe('TimeoutException', () => {
        it('is a TrialError named TimeoutException', () => {
            const err = new TimeoutException('too slow');
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('TimeoutException');
            expect(err.message).toBe('too slow');
        });
    });

    describe('TrialValidationError', () => {
        it('is a TrialError named TrialValidationError', () => {
            const err = new TrialValidationError('invalid input');
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('TrialValidationError');
        });
    });

    describe('TokenBucketTimeoutError', () => {
        it('stores the timeout and formats the message', () => {
            const err = new TokenBucketTimeoutError(5000);
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('TokenBucketTimeoutError');
            expect(err.timeoutMs).toBe(5000);
            expect(err.message).toBe('TokenBucket timeout: no token available within 5000ms');
        });
    });

    describe('EndpointAcquisitionTimeoutError', () => {
        it('describes a plain acquisition timeout', () => {
            const err = new EndpointAcquisitionTimeoutError(1000, 3);
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('EndpointAcquisitionTimeoutError');
            expect(err.timeoutMs).toBe(1000);
            expect(err.proxyCount).toBe(3);
            expect(err.budgetExhausted).toBe(false);
            expect(err.message).toBe('Proxy acquisition timeout: no proxy available within 1000ms (pool size: 3)');
        });

        it('describes a budget-exhausted acquisition', () => {
            const err = new EndpointAcquisitionTimeoutError(1000, 3, { budgetExhausted: true });
            expect(err.budgetExhausted).toBe(true);
            expect(err.message).toBe(
                'Proxy acquisition consumed the full 1000ms budget before fetch could start (pool size: 3)',
            );
        });
    });

    describe('CallerAbortedError', () => {
        it('is a plain Error named CallerAbortedError', () => {
            const err = new CallerAbortedError();
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe('CallerAbortedError');
            expect(err.message).toBe('The operation was aborted.');
        });

        it('accepts a custom message', () => {
            expect(new CallerAbortedError('cancelled').message).toBe('cancelled');
        });
    });
});
