import { describe, expect, it } from '@jest/globals';
import {
    ApiResponseValidationError,
    CallerAbortedError,
    ConfigurationError,
    EndpointAcquisitionTimeoutError,
    EndpointAssemblyError,
    HttpException,
    NetworkException,
    TimeoutException,
    TokenBucketTimeoutError,
    TrialError,
    TrialNotFoundError,
    TrialValidationError,
    UnexpectedError,
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

        describe('TrialError.normalize', () => {
            it('returns the error as-is when it is already a TrialError', () => {
                const err = new ConfigurationError('already a TrialError');
                expect(TrialError.normalize(err)).toBe(err);
            });

            it('wraps a plain Error in UnexpectedError', () => {
                const cause = new Error('raw');
                const result = TrialError.normalize(cause);
                expect(result).toBeInstanceOf(UnexpectedError);
                expect(result.cause).toBe(cause);
            });

            it('wraps a non-Error value in UnexpectedError', () => {
                const result = TrialError.normalize('something went wrong');
                expect(result).toBeInstanceOf(UnexpectedError);
                expect(result.message).toBe('Unexpected error: something went wrong');
            });
        });
    });

    it('preserves structured context', () => {
        const context = {
            endpoint: 'proxy-1',
            attempt: 2,
        };

        const err = new NetworkException('failed', { context });

        expect(err.context).toEqual(context);
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

    describe('ApiResponseValidationError', () => {
        it('stores the URL and formats the message', () => {
            const err = new ApiResponseValidationError('https://api.test/x', 'Invalid JSON response');

            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('ApiResponseValidationError');
            expect(err.url).toBe('https://api.test/x');
            expect(err.message).toBe('Invalid API response from https://api.test/x: Invalid JSON response');
        });

        it('preserves the original cause', () => {
            const cause = new SyntaxError('Unexpected token <');

            const err = new ApiResponseValidationError(
                'https://api.test/x',
                'Invalid JSON response: Unexpected token <',
                { cause },
            );

            expect(err.cause).toBe(cause);
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

            const err = new NetworkException('network failure', { cause });

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
            expect(err.message).toBe('invalid input');
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
            expect(err.message).toBe(
                'Endpoint acquisition timeout: no endpoint available within 1000ms (pool size: 3)',
            );
        });
    });

    describe('CallerAbortedError', () => {
        it('is a TrialError named CallerAbortedError', () => {
            const err = new CallerAbortedError();
            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('CallerAbortedError');
            expect(err.message).toBe('The operation was aborted.');
        });

        it('accepts a custom message', () => {
            expect(new CallerAbortedError('cancelled').message).toBe('cancelled');
        });
    });

    describe('UnexpectedError', () => {
        it('wraps an unexpected Error', () => {
            const cause = new Error('boom');
            const err = new UnexpectedError(cause);

            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('UnexpectedError');
            expect(err.cause).toBe(cause);
        });

        it('formats the message from the original error', () => {
            const err = new UnexpectedError(new Error('boom'));

            expect(err.message).toBe('Unexpected error: boom');
        });
    });

    describe('EndpointAssemblyError', () => {
        it('stores cause, cleanup errors, and context', () => {
            const cause = new Error('construction failed');
            const cleanupError = new Error('cleanup failed');

            const err = new EndpointAssemblyError(
                'Endpoint assembly failed.',
                {
                    cause,
                    context: {
                        endpointId: 'proxy-1',
                    },
                },
                [cleanupError],
            );

            expect(err).toBeInstanceOf(TrialError);
            expect(err.name).toBe('EndpointAssemblyError');
            expect(err.message).toBe('Endpoint assembly failed.');
            expect(err.cause).toBe(cause);
            expect(err.cleanupErrors).toEqual([cleanupError]);
            expect(err.context).toEqual({
                endpointId: 'proxy-1',
            });
        });

        it('defaults cleanupErrors to an empty array', () => {
            const err = new EndpointAssemblyError('assembly failed');

            expect(err.cleanupErrors).toEqual([]);
        });
    });
});
