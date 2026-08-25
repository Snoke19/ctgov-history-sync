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

        it('accepts backoffCapMs equal to baseDelayMs', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    baseDelayMs: 1000,
                    backoffCapMs: 1000,
                }),
            ).not.toThrow();
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

        it('rejects 404 as retryable', () => {
            expect(() =>
                validateRetryPolicyConfig({
                    ...defaultRetryPolicyConfig,
                    retryableStatusCodes: new Set([404]),
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

        it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
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

        it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
            'rejects invalid backoffCapMs: %s',
            (backoffCapMs) => {
                expect(() =>
                    validateRetryPolicyConfig({
                        ...defaultRetryPolicyConfig,
                        backoffCapMs,
                    }),
                ).toThrow(ConfigurationError);
            },
        );
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

        describe('overflow protection', () => {
            it('caps the delay at backoffCapMs for very large attempt counts', () => {
                const result = calculateBackoff(10_000, null, {
                    baseDelayMs: 100,
                    backoffCapMs: 10_000,
                    random: () => 0,
                });

                expect(result).toBe(10_000);
            });

            it('handles attempt counts resulting in Infinity exponential base', () => {
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

            it('computes fractional base delay for negative attempt count', () => {
                const backoff = calculateBackoff(-1, null, noJitter);
                expect(backoff).toBe(BASE * 0.5);
            });
        });

        describe('jitter', () => {
            it('uses zero jitter when random returns 0', () => {
                expect(
                    calculateBackoff(2, null, {
                        random: () => 0,
                        baseDelayMs: BASE,
                        backoffCapMs: CAP,
                    }),
                ).toBe(BASE * 4);
            });

            it('adds up to 50% random jitter', () => {
                const withoutJitter = calculateBackoff(0, null, {
                    ...noJitter,
                    random: () => 0,
                });

                const withMaxJitter = calculateBackoff(0, null, {
                    ...noJitter,
                    random: () => 1,
                });

                expect(withoutJitter).toBe(BASE);
                expect(withMaxJitter).toBe(BASE + BASE * 0.5);
            });

            it('correctly scales jitter for intermediate random values (e.g. 0.5)', () => {
                const backoff = calculateBackoff(0, null, {
                    ...noJitter,
                    random: () => 0.5,
                });

                // Jitter is random() * baseDelay * 0.5 => 0.5 * 1000 * 0.5 = 250
                expect(backoff).toBe(1250);
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

            it('caps Infinity Retry-After at the configured cap', () => {
                const backoff = calculateBackoff(0, Number.POSITIVE_INFINITY, noJitter);
                expect(backoff).toBe(CAP);
            });

            it('falls back to exponential backoff when Retry-After is null', () => {
                const backoff = calculateBackoff(0, null, noJitter);

                expect(backoff).toBe(BASE);
            });

            it('falls back to exponential backoff when Retry-After is NaN', () => {
                const backoff = calculateBackoff(0, Number.NaN, noJitter);
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

            it('preserves fractional Retry-After values', () => {
                const backoff = calculateBackoff(0, 150.75, noJitter);
                expect(backoff).toBe(150.75);
            });

            it('falls back to exponential backoff when Retry-After is negative', () => {
                const backoff = calculateBackoff(0, -1000, noJitter);

                expect(backoff).toBe(BASE);
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
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': '9007199254740' }))).toBe(
                    9007199254740000,
                );
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

                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': dateStr }), now)).toBe(
                    parsedMs - now,
                );
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
                expect(parseRetryAfterHeader(makeResponse({ 'Retry-After': 'Fri, 32 Dec 2026 99:99:99 GMT' }))).toBeNull();
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

