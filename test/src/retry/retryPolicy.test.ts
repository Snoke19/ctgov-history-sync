import { describe, expect, it, jest } from '@jest/globals';
import { defaultRetryPolicyConfig } from '../../../src/api/api.js';
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
import { HttpResponse } from '../../../src/http/transport/httpTransport.js';
import {
    calculateBackoff,
    parseRetryAfterHeader,
    RetryPolicyConfig,
    shouldRetry,
    validateRetryPolicyConfig,
} from '../../../src/retry/retryPolicy.js';

describe('retryPolicy', () => {
    describe('validateRetryPolicyConfig', () => {
        it.each(['true', 1, null, undefined, {}, []])('rejects non-boolean retryOnTimeout: %s', (retryOnTimeout) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryOnTimeout: retryOnTimeout as unknown as boolean,
                }),
            ).toThrow('retryOnTimeout must be a boolean');
        });

        it.each(['true', 1, null, undefined, {}, []])(
            'rejects non-boolean retryOnNetworkError: %s',
            (retryOnNetworkError) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        retryOnNetworkError: retryOnNetworkError as unknown as boolean,
                    }),
                ).toThrow('retryOnNetworkError must be a boolean');
            },
        );

        it('does not mutate the provided configuration', () => {
            const config = {
                ...defaultRetryPolicyConfig,
                retryableStatusCodes: new Set([500]),
            };
            const originalCodes = new Set(config.retryableStatusCodes);
            validateRetryPolicyConfig(config);
            expect(config.retryableStatusCodes).toEqual(originalCodes);
        });

        it('accepts valid boundary values', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([100, 599]),
                    baseDelayMs: 1,
                    backoffCapMs: 1,
                }),
            ).not.toThrow();
        });

        it('accepts empty retryableStatusCodes set', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set(),
                }),
            ).not.toThrow();
        });

        it.each([1, 100, 1000, Number.MAX_SAFE_INTEGER])(
            'accepts baseDelayMs equal to backoffCapMs at value %s',
            (value) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        baseDelayMs: value,
                        backoffCapMs: value,
                    }),
                ).not.toThrow();
            },
        );

        it('accepts large valid delay values', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    baseDelayMs: Number.MAX_SAFE_INTEGER,
                    backoffCapMs: Number.MAX_SAFE_INTEGER,
                }),
            ).not.toThrow();
        });

        it('accepts config with all fields at valid extreme values', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    retryOnTimeout: true,
                    retryOnNetworkError: true,
                    retryableStatusCodes: new Set([100, 599]),
                    baseDelayMs: 1,
                    backoffCapMs: Number.MAX_SAFE_INTEGER,
                }),
            ).not.toThrow();
        });

        it('accepts empty status codes with large delays', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set(),
                    baseDelayMs: Number.MAX_SAFE_INTEGER,
                    backoffCapMs: Number.MAX_SAFE_INTEGER,
                }),
            ).not.toThrow();
        });

        it.each([null, undefined, [500], { 500: true }, '500', 500])(
            'rejects non-Set retryableStatusCodes: %s',
            (codes) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        retryableStatusCodes: codes as unknown as Set<number>,
                    }),
                ).toThrow(ConfigurationError);
            },
        );

        it('rejects 404 as retryable with specific error message', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([404]),
                }),
            ).toThrow(
                '404 must not be in retryableStatusCodes. ' +
                    'The allow404 option depends on 404 being non-retryable so that ' +
                    'retry.perform() throws an HttpException instead of looping.',
            );
        });

        it('rejects configuration when one status code in the set is invalid', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([500, 700, 503]),
                }),
            ).toThrow(ConfigurationError);
        });

        it.each([99, 0, -1, -500])('rejects status codes below 100 (%s)', (status) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([status]),
                }),
            ).toThrow(ConfigurationError);
        });

        it.each([600, 601, 1000])('rejects status codes above 599 (%s)', (status) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([status]),
                }),
            ).toThrow(ConfigurationError);
        });

        it.each([500.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
            'rejects non-integer status codes: %s',
            (status) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        retryableStatusCodes: new Set([status]),
                    }),
                ).toThrow(ConfigurationError);
            },
        );

        it.each(['500', '500.5', true, false, null, undefined, {}, []])(
            'rejects Set containing non-number status codes: %s',
            (status) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        retryableStatusCodes: new Set([500, status as unknown as number]),
                    }),
                ).toThrow(ConfigurationError);
            },
        );

        it.each([0, -1, 0.1, 1.1, 1.5, 1.99, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
            'rejects invalid baseDelayMs: %s',
            (baseDelayMs) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        baseDelayMs,
                    }),
                ).toThrow(ConfigurationError);
            },
        );

        it.each([Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER * 10])(
            'rejects unsafe baseDelayMs: %s',
            (baseDelayMs) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        baseDelayMs,
                    }),
                ).toThrow(ConfigurationError);
            },
        );

        it.each([Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER * 10])(
            'rejects unsafe backoffCapMs: %s',
            (backoffCapMs) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        backoffCapMs,
                    }),
                ).toThrow(ConfigurationError);
            },
        );

        it.each<boolean>([true, false])('rejects boolean baseDelayMs: %s', (value) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    baseDelayMs: value as unknown as number,
                }),
            ).toThrow(ConfigurationError);
        });

        it.each(['1000', '1', '', 'abc'])('rejects string baseDelayMs: %s', (baseDelayMs) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    baseDelayMs: baseDelayMs as unknown as number,
                }),
            ).toThrow(ConfigurationError);
        });

        it.each([{}, [], new Date(), /regex/])('rejects object-like baseDelayMs: %s', (baseDelayMs) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    baseDelayMs: baseDelayMs as unknown as number,
                }),
            ).toThrow(ConfigurationError);
        });

        it.each([
            0,
            -1,
            -100,
            -Number.MAX_SAFE_INTEGER,
            0.1,
            1.1,
            1.5,
            1.99,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
        ])('rejects invalid backoffCapMs: %s', (backoffCapMs) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    backoffCapMs,
                }),
            ).toThrow(ConfigurationError);
        });

        it.each<boolean>([true, false])('rejects boolean backoffCapMs: %s', (value) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    backoffCapMs: value as unknown as number,
                }),
            ).toThrow(ConfigurationError);
        });

        it.each(['1000', '1', '', 'abc'])('rejects string backoffCapMs: %s', (backoffCapMs) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    backoffCapMs: backoffCapMs as unknown as number,
                }),
            ).toThrow(ConfigurationError);
        });

        it.each([{}, [], new Date(), /regex/])('rejects object-like backoffCapMs: %s', (backoffCapMs) => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    backoffCapMs: backoffCapMs as unknown as number,
                }),
            ).toThrow(ConfigurationError);
        });

        it('rejects backoffCapMs strictly less than baseDelayMs', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    baseDelayMs: 1000,
                    backoffCapMs: 999,
                }),
            ).toThrow('backoffCapMs must be >= baseDelayMs');
        });

        it('provides useful error details for invalid status code', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([700]),
                }),
            ).toThrow(
                'retryableStatusCodes contains invalid status: 700. ' +
                    'Status code must be an integer between 100 and 599.',
            );
        });
    });

    describe('shouldRetry', () => {
        describe('CallerAbortedError', () => {
            it('never retries even when retryable errors are enabled', () => {
                expect(shouldRetry(new CallerAbortedError('aborted'), defaultRetryPolicyConfig)).toBe(false);
            });
        });

        describe('TimeoutException', () => {
            it('returns true when retryOnTimeout is enabled', () => {
                expect(shouldRetry(new TimeoutException('timeout'), defaultRetryPolicyConfig)).toBe(true);
            });

            it('returns false when retryOnTimeout is disabled', () => {
                const config: RetryPolicyConfig = {
                    ...defaultRetryPolicyConfig,
                    retryOnTimeout: false,
                };

                expect(shouldRetry(new TimeoutException('timeout'), config)).toBe(false);
            });
        });

        describe('NetworkException', () => {
            it('returns true when retryOnNetworkError is enabled', () => {
                expect(shouldRetry(new NetworkException('econnreset'), defaultRetryPolicyConfig)).toBe(true);
            });

            it('returns false when retryOnNetworkError is disabled', () => {
                const config: RetryPolicyConfig = {
                    ...defaultRetryPolicyConfig,
                    retryOnNetworkError: false,
                };

                expect(shouldRetry(new NetworkException('econnreset'), config)).toBe(false);
            });
        });

        describe('HttpException', () => {
            it('returns true for a custom configured retryable status', () => {
                const config: RetryPolicyConfig = {
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([418]),
                };

                expect(shouldRetry(new HttpException('retryable error', 418), config)).toBe(true);
            });

            it.each([408, 429, 500, 502, 503, 504])('returns true for retryable status %s', (status) => {
                expect(shouldRetry(new HttpException('retryable error', status), defaultRetryPolicyConfig)).toBe(true);
            });

            it.each([400, 401, 403, 404, 0, -1, 200, 301])('returns false for non-retryable status %s', (status) => {
                expect(shouldRetry(new HttpException('non-retryable error', status), defaultRetryPolicyConfig)).toBe(
                    false,
                );
            });

            it('supports custom subclasses of HttpException', () => {
                class CustomHttpException extends HttpException {}
                const error = new CustomHttpException('custom gateway error', 502);

                expect(shouldRetry(error, defaultRetryPolicyConfig)).toBe(true);
            });
        });

        describe('non-retryable TrialError subclasses', () => {
            it.each([
                ['UnexpectedError', new UnexpectedError(new Error('crash'))],
                ['ConfigurationError', new ConfigurationError('invalid config')],
                ['TrialValidationError', new TrialValidationError('invalid trial format')],
                ['ApiResponseValidationError', new ApiResponseValidationError('https://api.test', 'bad payload')],
                ['TrialNotFoundError', new TrialNotFoundError('NCT12345678')],
                ['TokenBucketTimeoutError', new TokenBucketTimeoutError(1000)],
                ['EndpointAcquisitionTimeoutError', new EndpointAcquisitionTimeoutError(1000, 5)],
                ['EndpointAssemblyError', new EndpointAssemblyError('assembly failed')],
                ['Generic TrialError', new TrialError('unknown error')],
            ])('never retries %s', (_, error) => {
                expect(shouldRetry(error, defaultRetryPolicyConfig)).toBe(false);
            });
        });

        describe('when all retries are disabled', () => {
            const allDisabledConfig: RetryPolicyConfig = {
                retryOnTimeout: false,
                retryOnNetworkError: false,
                retryableStatusCodes: new Set(),
                baseDelayMs: 1000,
                backoffCapMs: 10000,
            };

            it('returns false for all error types', () => {
                expect(shouldRetry(new TimeoutException('timeout'), allDisabledConfig)).toBe(false);
                expect(shouldRetry(new NetworkException('network error'), allDisabledConfig)).toBe(false);
                expect(shouldRetry(new HttpException('server error', 500), allDisabledConfig)).toBe(false);
                expect(shouldRetry(new CallerAbortedError('aborted'), allDisabledConfig)).toBe(false);
            });
        });
    });

    describe('calculateBackoff', () => {
        const BASE = 1000;
        const CAP = 30000;

        const noJitter = {
            random: () => 0,
            baseDelayMs: BASE,
            backoffCapMs: CAP,
        };

        describe('jitter', () => {
            it('wraps an exception thrown by random() in RetryDelayCalculationError', () => {
                const randomError = new Error('random source failed');

                expect(() =>
                    calculateBackoff(0, null, {
                        random: () => {
                            throw randomError;
                        },
                        baseDelayMs: 1_000,
                        backoffCapMs: 10_000,
                    }),
                ).toThrow(
                    expect.objectContaining({
                        name: 'RetryDelayCalculationError',
                        message: 'Failed to calculate retry delay: random source failed',
                        cause: randomError,
                    }),
                );
            });

            it('returns the base delay when random returns 0', () => {
                const result = calculateBackoff(0, null, {
                    random: () => 0,
                    baseDelayMs: 1_000,
                    backoffCapMs: 10_000,
                });

                expect(result).toBe(1_000);
            });

            it('returns base delay plus the maximum 50% jitter when random returns 1', () => {
                const result = calculateBackoff(0, null, {
                    random: () => 1,
                    baseDelayMs: 1_000,
                    backoffCapMs: 10_000,
                });

                expect(result).toBe(1_500);
            });

            it('correctly scales jitter for intermediate random values', () => {
                const result = calculateBackoff(0, null, {
                    ...noJitter,
                    random: () => 0.5,
                });

                expect(result).toBe(1_250);
            });

            it.each([
                ['negative', -0.01],
                ['above one', 1.01],
                ['NaN', Number.NaN],
                ['positive Infinity', Number.POSITIVE_INFINITY],
                ['negative Infinity', Number.NEGATIVE_INFINITY],
            ])('rejects invalid random() output: %s', (_, value) => {
                expect(() =>
                    calculateBackoff(0, null, {
                        random: () => value,
                        baseDelayMs: 1_000,
                        backoffCapMs: 10_000,
                    }),
                ).toThrow(ConfigurationError);
            });
        });

        describe('input validation', () => {
            it('wraps an exception thrown by random() in RetryDelayCalculationError', () => {
                const randomError = new Error('random source failed');

                expect(() =>
                    calculateBackoff(0, null, {
                        random: () => {
                            throw randomError;
                        },
                        baseDelayMs: 1_000,
                        backoffCapMs: 10_000,
                    }),
                ).toThrow(
                    expect.objectContaining({
                        name: 'RetryDelayCalculationError',
                        message: 'Failed to calculate retry delay: random source failed',
                        cause: randomError,
                    }),
                );
            });

            it('does not call random when Retry-After is provided', () => {
                const random = jest.fn(() => {
                    throw new Error('random should not be called');
                });

                const result = calculateBackoff(0, 2_000, {
                    random,
                    baseDelayMs: 1_000,
                    backoffCapMs: 10_000,
                });

                expect(result).toBe(2_000);
                expect(random).not.toHaveBeenCalled();
            });

            it('throws for fractional retryAfterMs', () => {
                expect(() => calculateBackoff(0, 150.75, noJitter)).toThrow(ConfigurationError);
                expect(() => calculateBackoff(0, 150.75, noJitter)).toThrow('retryAfterMs must be an integer');
            });

            it('throws for negative retryAfterMs', () => {
                expect(() => calculateBackoff(0, -1000, noJitter)).toThrow(ConfigurationError);
                expect(() => calculateBackoff(0, -1000, noJitter)).toThrow('retryAfterMs must be non-negative');
            });

            it('throws for NaN retryAfterMs', () => {
                expect(() => calculateBackoff(0, Number.NaN, noJitter)).toThrow(ConfigurationError);
                expect(() => calculateBackoff(0, Number.NaN, noJitter)).toThrow('retryAfterMs must be an integer');
            });

            it('throws for Infinity retryAfterMs', () => {
                expect(() => calculateBackoff(0, Number.POSITIVE_INFINITY, noJitter)).toThrow(ConfigurationError);
                expect(() => calculateBackoff(0, Number.NEGATIVE_INFINITY, noJitter)).toThrow(ConfigurationError);
            });
        });

        describe('overflow protection', () => {
            it('caps very large finite exponential values', () => {
                const result = calculateBackoff(10_000, null, {
                    baseDelayMs: 100,
                    backoffCapMs: 10_000,
                    random: () => 0,
                });

                expect(result).toBe(10_000);
            });

            it('returns the cap when exponential calculation overflows to Infinity', () => {
                const result = calculateBackoff(1024, null, noJitter);
                expect(result).toBe(CAP);
            });
        });

        describe('exponential backoff', () => {
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

            it('throws for negative attempt', () => {
                expect(() => calculateBackoff(-1, null, noJitter)).toThrow(ConfigurationError);
                expect(() => calculateBackoff(-1, null, noJitter)).toThrow('attempt must be a non-negative integer');
            });

            it('throws for fractional attempt', () => {
                expect(() => calculateBackoff(1.5, null, noJitter)).toThrow(ConfigurationError);
            });

            it('throws for non-integer baseDelayMs', () => {
                const opts = { ...noJitter, baseDelayMs: 100.5 };
                expect(() => calculateBackoff(0, null, opts)).toThrow(ConfigurationError);
            });

            it('throws for zero baseDelayMs', () => {
                const opts = { ...noJitter, baseDelayMs: 0 };
                expect(() => calculateBackoff(0, null, opts)).toThrow(ConfigurationError);
            });

            it('throws for negative backoffCapMs', () => {
                const opts = { ...noJitter, backoffCapMs: -100 };
                expect(() => calculateBackoff(0, null, opts)).toThrow(ConfigurationError);
            });
        });

        describe('backoff cap', () => {
            it('caps backoff at the configured cap', () => {
                const backoff = calculateBackoff(20, null, noJitter);

                expect(backoff).toBe(CAP);
            });

            it('never exceeds the backoff cap even with maximum jitter', () => {
                const backoff = calculateBackoff(10, null, {
                    random: () => 1,
                    baseDelayMs: BASE,
                    backoffCapMs: CAP,
                });

                expect(backoff).toBe(CAP);
            });
        });

        describe('Retry-After', () => {
            it('does not call random when Retry-After is provided', () => {
                const random = jest.fn(() => {
                    throw new Error('random should not be called');
                });

                const result = calculateBackoff(0, 2_000, {
                    random,
                    baseDelayMs: 1_000,
                    backoffCapMs: 10_000,
                });

                expect(result).toBe(2_000);
                expect(random).not.toHaveBeenCalled();
            });

            it('honors Retry-After header value', () => {
                const backoff = calculateBackoff(0, 2000, noJitter);

                expect(backoff).toBe(2000);
            });

            it('returns Retry-After exactly when it equals the cap', () => {
                expect(calculateBackoff(0, CAP, noJitter)).toBe(CAP);
            });

            it('prioritizes Retry-After even when smaller than baseDelayMs', () => {
                const backoff = calculateBackoff(0, 50, noJitter);
                expect(backoff).toBe(50);
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

            it('uses 0 Retry-After as an immediate retry delay', () => {
                const backoff = calculateBackoff(0, 0, noJitter);

                expect(backoff).toBe(0);
            });

            it('handles -0 Retry-After as 0', () => {
                const backoff = calculateBackoff(0, -0, noJitter);
                expect(backoff === 0).toBe(true);
                expect(Math.abs(backoff)).toBe(0);
            });
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

        it('throws for non-integer now parameter', () => {
            expect(() => parseRetryAfterHeader(makeResponse({}), 123.45)).toThrow(ConfigurationError);
            expect(() => parseRetryAfterHeader(makeResponse({}), 123.45)).toThrow('now must be an integer');
        });

        it('returns null when Retry-After header is present but empty after trimming', () => {
            const getHeader = jest.fn().mockReturnValue('   ');
            const response = {
                headers: { get: getHeader },
            } as unknown as HttpResponse;

            const result = parseRetryAfterHeader(response);

            expect(result).toBeNull();
            expect(getHeader).toHaveBeenCalledWith('Retry-After');
        });

        describe('header presence / invalid values', () => {
            it('returns null when milliseconds exceed the safe integer range', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '9007199254741' }))).toBeNull();
            });

            it('parses milliseconds at the exact maximum safe integer seconds boundary', () => {
                // 9007199254740 * 1000 = 9007199254740000 <= Number.MAX_SAFE_INTEGER (9007199254740991)
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '9007199254740' }))).toBe(9007199254740000);
            });

            it('returns null when header is absent', () => {
                expect(parseRetryAfterHeader(makeResponse({}))).toBeNull();
            });

            it('returns null for empty string or whitespace-only headers', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': ' \t\r\n ' }))).toBeNull();
            });

            it('returns null for unparsable values', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'garbage' }))).toBeNull();
            });

            it('returns null for invalid numeric Retry-After values', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'Infinity' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '-Infinity' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'NaN' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '-1' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '-0' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '+5' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '1.5' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '0.5' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '120s' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '120ms' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '120 seconds' }))).toBeNull();
            });

            it('returns null for unsafe numeric Retry-After values', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '9007199254740992' }))).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '999999999999999999999' }))).toBeNull();
            });
        });

        describe('delay-seconds', () => {
            it('trims surrounding whitespace including tabs and newlines', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '\t 5 \r\n' }))).toBe(5000);
            });

            it('parses delay-seconds format', () => {
                const result = parseRetryAfterHeader(makeResponse({ 'Retry-After': '5' }));
                expect(result).toBe(5000);
            });

            it('parses 0 delay-seconds as 0 ms', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '0' }))).toBe(0);
            });

            it('parses delay-seconds with leading zeros', () => {
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '00007' }))).toBe(7000);
            });
        });

        describe('HTTP-date', () => {
            it('returns 0 when HTTP-date equals now', () => {
                const now = Date.parse('2026-08-13T00:00:00Z');
                const dateStr = new Date(now).toUTCString();

                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }), now)).toBe(0);
            });

            it('parses standard RFC 1123 / IMF-fixdate format', () => {
                const now = Date.parse('2026-08-13T00:00:00Z');
                const dateStr = new Date(now + 3000).toUTCString();

                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }), now)).toBe(3000);
            });

            it('parses RFC 850 date format', () => {
                const now = Date.parse('2026-08-13T00:00:00Z');
                // RFC 850: "Wednesday, 13-Aug-26 00:00:05 GMT"
                const dateStr = 'Wednesday, 13-Aug-26 00:00:05 GMT';
                const parsedMs = Date.parse(dateStr);

                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }), now)).toBe(parsedMs - now);
            });

            it('parses ANSI C asctime format', () => {
                // ANSI C: "Wed Aug 13 00:00:10 2026"
                const dateStr = 'Wed Aug 13 00:00:10 2026';
                const parsedMs = Date.parse(dateStr);
                const now = parsedMs - 10000;

                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }), now)).toBe(10000);
            });

            it('returns 0 for a past HTTP-date', () => {
                const now = Date.parse('2026-08-13T00:00:00Z');
                const past = new Date(now - 3000).toUTCString();

                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': past }), now)).toBe(0);
            });

            it('returns null for malformed or impossible HTTP-dates', () => {
                expect(
                    parseRetryAfterHeader(makeResponse({ 'Retry-After': 'Fri, 32 Dec 2026 99:99:99 GMT' })),
                ).toBeNull();
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'Not-A-Valid-Date' }))).toBeNull();
            });

            it('uses system wall clock by default when now parameter is omitted', () => {
                const futureDate = new Date(Date.now() + 5000).toUTCString();
                const delay = parseRetryAfterHeader(makeResponse({ 'Retry-After': futureDate }));

                expect(delay).not.toBeNull();
                expect(delay).toBeGreaterThan(0);
                expect(delay).toBeLessThanOrEqual(5000);
            });
        });
    });
});
