import {afterEach, describe, expect, it} from "@jest/globals";
import {env, parseStatusCodes, validateConfig} from '../src/config/configValidation.js'

describe('env.int', () => {
    afterEach(() => {
        delete process.env.TEST_INT
    });

    it('returns parsed integer for valid string', () => {
        process.env.TEST_INT = '42';
        expect(env.int('TEST_INT', 0)).toBe(42);
    });

    it('returns negative integer', () => {
        process.env.TEST_INT = '-99';
        expect(env.int('TEST_INT', 0)).toBe(-99);
    });

    it('returns fallback when env is undefined', () => {
        expect(env.int('TEST_INT', 7)).toBe(7);
    });

    it('returns fallback when env is empty string', () => {
        process.env.TEST_INT = '';
        expect(env.int('TEST_INT', 7)).toBe(7);
    });

    it('throws on decimal string', () => {
        process.env.TEST_INT = '3.14';
        expect(() => env.int('TEST_INT', 0)).toThrow('Invalid integer value for TEST_INT: "3.14"');
    });

    it('throws on alphanumeric garbage', () => {
        process.env.TEST_INT = '123abc';
        expect(() => env.int('TEST_INT', 0)).toThrow('Invalid integer value for TEST_INT: "123abc"');
    });

    it('throws on hex string', () => {
        process.env.TEST_INT = '0x10';
        expect(() => env.int('TEST_INT', 0)).toThrow('Invalid integer value for TEST_INT: "0x10"');
    });

    it('throws on whitespace-only', () => {
        process.env.TEST_INT = '   ';
        expect(() => env.int('TEST_INT', 0)).toThrow('Invalid integer value for TEST_INT: "   "');
    });

    it('throws on plus sign prefix', () => {
        process.env.TEST_INT = '+5';
        expect(() => env.int('TEST_INT', 0)).toThrow('Invalid integer value for TEST_INT: "+5"');
    });

    it('throws on empty string inside trimmed value', () => {
        process.env.TEST_INT = '  7  ';
        expect(env.int('TEST_INT', 0)).toBe(7); // should work because trim happens before regex
    });
});

describe('env.str', () => {
    afterEach(() => delete process.env.TEST_STR);

    it('returns the raw string', () => {
        process.env.TEST_STR = 'hello';
        expect(env.str('TEST_STR', 'fallback')).toBe('hello');
    });

    it('returns fallback when undefined', () => {
        expect(env.str('TEST_STR', 'fallback')).toBe('fallback');
    });

    it('returns fallback when empty string', () => {
        process.env.TEST_STR = '';
        expect(env.str('TEST_STR', 'fallback')).toBe('fallback');
    });

    it('throws on whitespace-only string', () => {
        process.env.TEST_STR = '   ';
        expect(() => env.str('TEST_STR', 'fallback')).toThrow('Invalid string value for TEST_STR: whitespace-only');
    });

    it('trims surrounding whitespace from valid strings', () => {
        process.env.TEST_STR = '  hello  ';
        expect(env.str('TEST_STR', 'fallback')).toBe('hello');
    });
});

describe('env.bool', () => {
    afterEach(() => delete process.env.TEST_BOOL);

    it('returns true for "true"', () => {
        process.env.TEST_BOOL = 'true';
        expect(env.bool('TEST_BOOL')).toBe(true);
    });

    it('returns true for "TRUE"', () => {
        process.env.TEST_BOOL = 'TRUE';
        expect(env.bool('TEST_BOOL')).toBe(true);
    });

    it('returns false for "false"', () => {
        process.env.TEST_BOOL = 'false';
        expect(env.bool('TEST_BOOL')).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(env.bool('TEST_BOOL')).toBe(false);
    });

    it('returns false for empty string', () => {
        process.env.TEST_BOOL = '';
        expect(env.bool('TEST_BOOL')).toBe(false);
    });

    it('throws on "1"', () => {
        process.env.TEST_BOOL = '1';
        expect(() => env.bool('TEST_BOOL')).toThrow('Invalid boolean value for TEST_BOOL: "1"');
    });

    it('throws on "yes"', () => {
        process.env.TEST_BOOL = 'yes';
        expect(() => env.bool('TEST_BOOL')).toThrow('Invalid boolean value for TEST_BOOL: "yes"');
    });

    it('throws on "maybe"', () => {
        process.env.TEST_BOOL = 'maybe';
        expect(() => env.bool('TEST_BOOL')).toThrow('Invalid boolean value for TEST_BOOL: "maybe"');
    });
});

describe('parseStatusCodes', () => {
    afterEach(() => delete process.env.STATUS_CODES);

    it('returns Set of valid codes', () => {
        process.env.STATUS_CODES = '200,404,500';
        const set = parseStatusCodes('STATUS_CODES', [200]);
        expect(set).toEqual(new Set([200, 404, 500]));
    });

    it('trims whitespace around codes', () => {
        process.env.STATUS_CODES = ' 200 , 404 ';
        const set = parseStatusCodes('STATUS_CODES', []);
        expect(set).toEqual(new Set([200, 404]));
    });

    it('returns fallback Set when env is undefined', () => {
        const set = parseStatusCodes('STATUS_CODES', [500]);
        expect(set).toEqual(new Set([500]));
    });

    it('returns fallback Set when env is empty string', () => {
        process.env.STATUS_CODES = '';
        const set = parseStatusCodes('STATUS_CODES', [500]);
        expect(set).toEqual(new Set([500]));
    });

    it('throws on empty item between commas', () => {
        process.env.STATUS_CODES = '200,,404';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Empty status code in STATUS_CODES at position 1');
    });

    it('throws on non-numeric code', () => {
        process.env.STATUS_CODES = '200,abc';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Invalid status code in STATUS_CODES: "abc"');
    });

    it('throws on decimal code', () => {
        process.env.STATUS_CODES = '200.5';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Invalid status code in STATUS_CODES: "200.5"');
    });

    it('throws on negative code', () => {
        process.env.STATUS_CODES = '-200';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Invalid status code in STATUS_CODES: "-200"');
    });

    it('throws on code below 100', () => {
        process.env.STATUS_CODES = '99';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Invalid status code in STATUS_CODES: "99"');
    });

    it('throws on code above 599', () => {
        process.env.STATUS_CODES = '600';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Invalid status code in STATUS_CODES: "600"');
    });

    it('throws on out-of-range safe integer', () => {
        process.env.STATUS_CODES = '9999999999999999';
        expect(() => parseStatusCodes('STATUS_CODES', [])).toThrow('Invalid status code in STATUS_CODES: "9999999999999999"');
    });

    describe('env.int — invalid string values (NaN guard)', () => {
        afterEach(() => {
            delete process.env.CONCURRENCY;
            delete process.env.FETCH_TIMEOUT_MS;
            delete process.env.MAX_RETRIES;
        });

        it('throws when CONCURRENCY=abc (would be NaN in old code)', () => {
            process.env.CONCURRENCY = 'abc';
            expect(() => env.int('CONCURRENCY', 4)).toThrow(
                'Invalid integer value for CONCURRENCY: "abc"'
            );
        });

        it('throws when FETCH_TIMEOUT_MS is a non-numeric string', () => {
            process.env.FETCH_TIMEOUT_MS = 'thirty';
            expect(() => env.int('FETCH_TIMEOUT_MS', 5000)).toThrow(
                'Invalid integer value for FETCH_TIMEOUT_MS: "thirty"'
            );
        });

        it('throws when MAX_RETRIES is an empty space string', () => {
            process.env.MAX_RETRIES = '   ';
            expect(() => env.int('MAX_RETRIES', 3)).toThrow(
                'Invalid integer value for MAX_RETRIES: "   "'
            );
        });

        it('throws when pool setting is a float string', () => {
            process.env.DB_POOL_SIZE = '5.5';
            expect(() => env.int('DB_POOL_SIZE', 10)).toThrow(
                'Invalid integer value for DB_POOL_SIZE: "5.5"'
            );
        });
    });
});

describe('validateConfig', () => {
    it('accepts valid API URLs', () => {
        expect(() =>
            validateConfig({
                apiBaseUrl: 'https://clinicaltrials.gov/api/v2/studies',
                apiDetailUrl: 'https://clinicaltrials.gov/api/int/studies',
            }),
        ).not.toThrow();
    });

    it('throws when API_BASE_URL is missing', () => {
        expect(() =>
            validateConfig({
                apiBaseUrl: '',
                apiDetailUrl: 'https://clinicaltrials.gov/api/int/studies',
            }),
        ).toThrow('Missing required config: API_BASE_URL');
    });

    it('throws when API_DETAIL_URL is missing', () => {
        expect(() =>
            validateConfig({
                apiBaseUrl: 'https://clinicaltrials.gov/api/v2/studies',
                apiDetailUrl: '   ',
            }),
        ).toThrow('Missing required config: API_DETAIL_URL');
    });

    it('throws when a URL is invalid', () => {
        expect(() =>
            validateConfig({
                apiBaseUrl: 'not-a-url',
                apiDetailUrl: 'https://clinicaltrials.gov/api/int/studies',
            }),
        ).toThrow('Invalid URL for API_BASE_URL: "not-a-url"');
    });
});