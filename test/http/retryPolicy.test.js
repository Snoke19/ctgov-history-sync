import {afterEach, beforeEach, describe, expect, jest, test} from "@jest/globals";
import {
    buildRetryableError,
    calculateBackoff,
    classifyError,
    isIdempotent,
    parseRetryAfterHeader
} from "../../src/http/retry/retryPolicy.js";
import {BACKOFF_CAP_MS, DEFAULT_RETRY_AFTER_MS} from "../../src/config/config.js";
import {EndpointAcquisitionTimeoutError, TrialFetchError, TrialTimeoutError} from "../../src/error/errors.js";

describe('isIdempotent', () => {
    test.each([
        {method: 'GET', expected: true},
        {method: 'HEAD', expected: true},
        {method: 'PUT', expected: true},
        {method: 'DELETE', expected: true},
        {method: 'OPTIONS', expected: true},
        {method: 'POST', expected: false},
        {method: 'PATCH', expected: false},
    ])('returns $expected for $method requests', ({method, expected}) => {
        expect(isIdempotent(method)).toBe(expected);
    });

    test('treats method names case-insensitively', () => {
        expect(isIdempotent('get')).toBe(true);
        expect(isIdempotent('DeLeTe')).toBe(true);
    });

    test('allows explicit override to enable retries', () => {
        expect(isIdempotent('POST', true)).toBe(true);
    });

    test('allows explicit override to disable retries', () => {
        expect(isIdempotent('GET', false)).toBe(false);
    });

    test('uses built-in method list when override is undefined', () => {
        expect(isIdempotent('GET', undefined)).toBe(true);
        expect(isIdempotent('POST', undefined)).toBe(false);
    });
});

describe('calculateBackoff', () => {
    let randomSpy;

    beforeEach(() => {
        randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('uses Retry-After delay when provided', () => {
        expect(calculateBackoff(3, 7000)).toBe(7000);
    });

    test('ignores Retry-After when it is zero or negative', () => {
        expect(calculateBackoff(0, 0)).toBe(1250);
        expect(calculateBackoff(0, -1000)).toBe(1250);
    });

    test('calculates exponential backoff with jitter', () => {
        expect(calculateBackoff(0)).toBe(1250);
        expect(calculateBackoff(1)).toBe(2500);
        expect(calculateBackoff(2)).toBe(5000);
    });

    test('applies no jitter when Math.random() returns zero', () => {
        randomSpy.mockReturnValue(0);

        expect(calculateBackoff(1)).toBe(2000);
    });

    test('never exceeds configured backoff cap', () => {
        randomSpy.mockReturnValue(0);

        expect(calculateBackoff(20)).toBe(BACKOFF_CAP_MS);
    });

    test('does not cap Retry-After delays supplied by the server', () => {
        expect(calculateBackoff(100, 60000)).toBe(60000);
    });
});

describe('parseRetryAfterHeader', () => {
    const response = (value) => ({
        headers: {
            get: jest.fn().mockReturnValue(value),
        },
    });

    test('returns null when Retry-After header is absent', () => {
        expect(parseRetryAfterHeader(response(null))).toBeNull();
    });

    test('parses delay expressed in seconds', () => {
        expect(parseRetryAfterHeader(response('120'))).toBe(120000);
    });

    test('accepts zero-second delays', () => {
        expect(parseRetryAfterHeader(response('0'))).toBe(0);
    });

    test('parses Retry-After HTTP dates', () => {
        jest.useFakeTimers();

        jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));

        const date = new Date('2025-01-01T00:00:10Z');

        expect(
            parseRetryAfterHeader(response(date.toUTCString()))
        ).toBe(10000);

        jest.useRealTimers();
    });

    test('returns the default delay when Retry-After date is in the past', () => {
        jest.useFakeTimers();

        jest.setSystemTime(new Date('2025-01-01T00:00:10Z'));

        const date = new Date('2025-01-01T00:00:00Z');

        expect(
            parseRetryAfterHeader(response(date.toUTCString()))
        ).toBe(DEFAULT_RETRY_AFTER_MS);

        jest.useRealTimers();
    });

    test('returns the default delay for invalid Retry-After values', () => {
        expect(parseRetryAfterHeader(response('invalid')))
            .toBe(DEFAULT_RETRY_AFTER_MS);
    });
});

describe('buildRetryableError', () => {
    const response = (status, retryAfter = null) => {
        const headers = new Headers();

        if (retryAfter !== null) {
            headers.set('Retry-After', retryAfter);
        }

        return new Response(null, {
            status,
            statusText: 'Too Many Requests',
            headers,
        });
    };

    test('creates a transient TrialFetchError', () => {
        const error = buildRetryableError(
            'https://example.com',
            response(429),
            'proxy-a'
        );

        expect(error).toBeInstanceOf(TrialFetchError);
        expect(error.url).toBe('https://example.com');
        expect(error.status).toBe(429);
        expect(error.isTransient).toBe(true);
        expect(error.cause).toBeInstanceOf(Error);
    });

    test('stores the proxy that produced the response', () => {
        const error = buildRetryableError(
            'url',
            response(500),
            'proxy-a'
        );

        expect(error.proxyUrl).toBe('proxy-a');
    });

    test('stores parsed Retry-After for supported status codes', () => {
        const error = buildRetryableError(
            'url',
            response(429, '10'),
            'proxy'
        );

        expect(error.retryAfterMs).toBe(10000);
    });

    test('uses the default Retry-After when the header is missing', () => {
        const error = buildRetryableError(
            'url',
            response(429),
            'proxy'
        );

        expect(error.retryAfterMs).toBe(DEFAULT_RETRY_AFTER_MS);
    });

    test('does not attach Retry-After for unsupported status codes', () => {
        const error = buildRetryableError(
            'url',
            response(500, '10'),
            'proxy'
        );

        expect(error.retryAfterMs).toBeNull();
    });
});

describe('classifyError', () => {
    test('recognizes endpoint acquisition timeouts', () => {
        expect(
            classifyError(new EndpointAcquisitionTimeoutError())
        ).toEqual({
            isTimeout: true,
            reason: 'Endpoint acquisition timeout',
        });
    });

    test('recognizes request timeouts', () => {
        expect(
            classifyError(new TrialTimeoutError())
        ).toEqual({
            isTimeout: true,
            reason: 'Request timeout',
        });
    });

    test('classifies all other errors as transient', () => {
        expect(
            classifyError(new Error('network error'))
        ).toEqual({
            isTimeout: false,
            reason: 'Transient error',
        });
    });

    test('does not rely on the error message', () => {
        expect(
            classifyError(
                new Error('Endpoint acquisition timeout')
            )
        ).toEqual({
            isTimeout: false,
            reason: 'Transient error',
        });
    });

    test('handles non-Error values', () => {
        expect(classifyError(null)).toEqual({
            isTimeout: false,
            reason: 'Transient error',
        });

        expect(classifyError(undefined)).toEqual({
            isTimeout: false,
            reason: 'Transient error',
        });

        expect(classifyError({})).toEqual({
            isTimeout: false,
            reason: 'Transient error',
        });
    });
});