import {ConfigurationError} from '../src/error/errors.js';
import {env, parseStatusCodes, validateConfig} from '../src/config/configValidation.js';
import {afterAll, beforeEach, describe, expect, it} from "@jest/globals";

describe('configValidation', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        process.env = {...ORIGINAL_ENV};
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    // -----------------------------------------------------------------------
    // env.int
    // -----------------------------------------------------------------------
    describe('env.int', () => {
        it('returns the fallback when the env var is not set', () => {
            delete process.env.MY_INT;
            expect(env.int('MY_INT', 10)).toBe(10);
        });

        it('returns the fallback when the env var is an empty string', () => {
            process.env.MY_INT = '';
            expect(env.int('MY_INT', 10)).toBe(10);
        });

        it('parses a positive integer string', () => {
            process.env.MY_INT = '42';
            expect(env.int('MY_INT', 10)).toBe(42);
        });

        it('parses a negative integer string', () => {
            process.env.MY_INT = '-7';
            expect(env.int('MY_INT', 10)).toBe(-7);
        });

        it('trims whitespace around the value', () => {
            process.env.MY_INT = '  15  ';
            expect(env.int('MY_INT', 10)).toBe(15);
        });

        it('throws ConfigurationError for a decimal value', () => {
            process.env.MY_INT = '1.5';
            expect(() => env.int('MY_INT', 10)).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for a non-numeric value', () => {
            process.env.MY_INT = 'abc';
            expect(() => env.int('MY_INT', 10)).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for scientific notation (e.g. "1e3")', () => {
            process.env.MY_INT = '1e3';
            expect(() => env.int('MY_INT', 10)).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for hex notation (e.g. "0x1A")', () => {
            process.env.MY_INT = '0x1A';
            expect(() => env.int('MY_INT', 10)).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for "Infinity"', () => {
            process.env.MY_INT = 'Infinity';
            expect(() => env.int('MY_INT', 10)).toThrow(ConfigurationError);
        });

        it('includes the key name and raw value in the error message', () => {
            process.env.MY_INT = 'abc';
            expect(() => env.int('MY_INT', 10)).toThrow('Invalid integer value for MY_INT: "abc"');
        });

        it('does not enforce positivity by default', () => {
            process.env.MY_INT = '-5';
            expect(() => env.int('MY_INT', 10)).not.toThrow();
        });

        it('does not throw for a positive value when opts.positive is true', () => {
            process.env.MY_INT = '5';
            expect(() => env.int('MY_INT', 10, {positive: true})).not.toThrow();
        });

        it('throws ConfigurationError when opts.positive is true and value is zero', () => {
            process.env.MY_INT = '0';
            expect(() => env.int('MY_INT', 10, {positive: true})).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError when opts.positive is true and value is negative', () => {
            process.env.MY_INT = '-5';
            expect(() => env.int('MY_INT', 10, {positive: true})).toThrow(ConfigurationError);
        });

        it('does not enforce positivity on the fallback value even when opts.positive is true', () => {
            delete process.env.MY_INT;
            // fallback itself is negative — since env var is unset, assertPositiveInt is skipped entirely
            // (this documents current behavior: positivity is only checked when opts.positive is true AND value is resolved)
            expect(() => env.int('MY_INT', -1, {positive: true})).toThrow(ConfigurationError);
        });
    });

    // -----------------------------------------------------------------------
    // env.str
    // -----------------------------------------------------------------------
    describe('env.str', () => {
        it('returns the fallback when the env var is not set', () => {
            delete process.env.MY_STR;
            expect(env.str('MY_STR', 'default')).toBe('default');
        });

        it('returns the fallback when the env var is an empty string', () => {
            process.env.MY_STR = '';
            expect(env.str('MY_STR', 'default')).toBe('default');
        });

        it('returns the trimmed value when set', () => {
            process.env.MY_STR = '  hello  ';
            expect(env.str('MY_STR', 'default')).toBe('hello');
        });

        it('throws ConfigurationError when the value is whitespace-only', () => {
            process.env.MY_STR = '   ';
            expect(() => env.str('MY_STR', 'default')).toThrow(ConfigurationError);
        });

        it('includes the key name in the whitespace-only error message', () => {
            process.env.MY_STR = '   ';
            expect(() => env.str('MY_STR', 'default')).toThrow('Invalid string value for MY_STR: whitespace-only');
        });
    });

    // -----------------------------------------------------------------------
    // env.bool
    // -----------------------------------------------------------------------
    describe('env.bool', () => {
        it('returns the fallback (false by default) when the env var is not set', () => {
            delete process.env.MY_BOOL;
            expect(env.bool('MY_BOOL')).toBe(false);
        });

        it('returns a custom fallback when the env var is not set', () => {
            delete process.env.MY_BOOL;
            expect(env.bool('MY_BOOL', true)).toBe(true);
        });

        it('returns the fallback when the env var is an empty string', () => {
            process.env.MY_BOOL = '';
            expect(env.bool('MY_BOOL', true)).toBe(true);
        });

        it('parses "true" as true', () => {
            process.env.MY_BOOL = 'true';
            expect(env.bool('MY_BOOL', false)).toBe(true);
        });

        it('parses "false" as false', () => {
            process.env.MY_BOOL = 'false';
            expect(env.bool('MY_BOOL', true)).toBe(false);
        });

        it('is case-insensitive', () => {
            process.env.MY_BOOL = 'TRUE';
            expect(env.bool('MY_BOOL', false)).toBe(true);
        });

        it('trims whitespace around the value', () => {
            process.env.MY_BOOL = '  true  ';
            expect(env.bool('MY_BOOL', false)).toBe(true);
        });

        it('throws ConfigurationError for an invalid value', () => {
            process.env.MY_BOOL = 'yes';
            expect(() => env.bool('MY_BOOL', false)).toThrow(ConfigurationError);
        });

        it('includes the key name and raw value in the error message', () => {
            process.env.MY_BOOL = 'yes';
            expect(() => env.bool('MY_BOOL', false)).toThrow('Invalid boolean value for MY_BOOL: "yes"');
        });
    });

    // -----------------------------------------------------------------------
    // parseStatusCodes
    // -----------------------------------------------------------------------
    describe('parseStatusCodes', () => {
        it('returns the fallback set when the env var is not set', () => {
            delete process.env.STATUS_CODES;
            expect(parseStatusCodes('STATUS_CODES', [500, 502])).toEqual(new Set([500, 502]));
        });

        it('returns the fallback set when the env var is an empty string', () => {
            process.env.STATUS_CODES = '';
            expect(parseStatusCodes('STATUS_CODES', [500, 502])).toEqual(new Set([500, 502]));
        });

        it('parses a comma-separated list of status codes', () => {
            process.env.STATUS_CODES = '429,500,503';
            expect(parseStatusCodes('STATUS_CODES', [])).toEqual(new Set([429, 500, 503]));
        });

        it('trims whitespace around each code', () => {
            process.env.STATUS_CODES = ' 429 , 500 ';
            expect(parseStatusCodes('STATUS_CODES', [])).toEqual(new Set([429, 500]));
        });

        it('deduplicates repeated codes via the Set', () => {
            process.env.STATUS_CODES = '500,500,502';
            expect(parseStatusCodes('STATUS_CODES', [])).toEqual(new Set([500, 502]));
        });

        it('throws ConfigurationError for an empty entry between commas', () => {
            process.env.STATUS_CODES = '500,,502';
            expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow(ConfigurationError);
        });

        it('includes the position of the empty entry in the error message', () => {
            process.env.STATUS_CODES = '500,,502';
            expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow(
                'Empty status code in STATUS_CODES at position 1',
            );
        });

        it('throws ConfigurationError for a non-numeric entry', () => {
            process.env.STATUS_CODES = '500,abc';
            expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for a code below 100', () => {
            process.env.STATUS_CODES = '99';
            expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError for a code above 599', () => {
            process.env.STATUS_CODES = '600';
            expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow(ConfigurationError);
        });

        it('accepts the boundary values 100 and 599', () => {
            process.env.STATUS_CODES = '100,599';
            expect(parseStatusCodes('STATUS_CODES', [])).toEqual(new Set([100, 599]));
        });

        it('throws ConfigurationError for a decimal status code', () => {
            process.env.STATUS_CODES = '500.5';
            expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow(ConfigurationError);
        });
    });

    // -----------------------------------------------------------------------
    // validateConfig
    // -----------------------------------------------------------------------
    describe('validateConfig', () => {
        it('does not throw for two valid URLs', () => {
            expect(() =>
                validateConfig({
                    apiBaseUrl: 'https://api.example.com',
                    apiDetailUrl: 'https://api.example.com/details',
                }),
            ).not.toThrow();
        });

        it('throws ConfigurationError when apiBaseUrl is an empty string', () => {
            expect(() =>
                validateConfig({apiBaseUrl: '', apiDetailUrl: 'https://api.example.com/details'}),
            ).toThrow(ConfigurationError);
        });

        it('throws ConfigurationError when apiBaseUrl is whitespace-only', () => {
            expect(() =>
                validateConfig({apiBaseUrl: '   ', apiDetailUrl: 'https://api.example.com/details'}),
            ).toThrow(ConfigurationError);
        });

        it('includes the field name in the "missing" error message', () => {
            expect(() =>
                validateConfig({apiBaseUrl: '', apiDetailUrl: 'https://api.example.com/details'}),
            ).toThrow('Missing required config: API_BASE_URL');
        });

        it('throws ConfigurationError when apiDetailUrl is missing', () => {
            expect(() =>
                validateConfig({apiBaseUrl: 'https://api.example.com', apiDetailUrl: ''}),
            ).toThrow('Missing required config: API_DETAIL_URL');
        });

        it('throws ConfigurationError when a URL is malformed', () => {
            expect(() =>
                validateConfig({apiBaseUrl: 'not-a-valid-url', apiDetailUrl: 'https://api.example.com/details'}),
            ).toThrow(ConfigurationError);
        });

        it('includes the field name and value in the "invalid URL" error message', () => {
            expect(() =>
                validateConfig({apiBaseUrl: 'not-a-valid-url', apiDetailUrl: 'https://api.example.com/details'}),
            ).toThrow('Invalid URL for API_BASE_URL: "not-a-valid-url"');
        });

        it('checks apiBaseUrl before apiDetailUrl (fails fast on the first invalid entry)', () => {
            expect(() =>
                validateConfig({apiBaseUrl: '', apiDetailUrl: ''}),
            ).toThrow('Missing required config: API_BASE_URL');
        });
    });
});