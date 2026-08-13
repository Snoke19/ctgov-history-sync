import { describe, expect, it } from '@jest/globals';
import { env } from '../src/config/configValidation.js';
import { ConfigurationError, TrialValidationError } from '../src/error/errors.js';
import { assertNonNegativeInt, assertPositiveInt, makeAssertions, validateNctId } from '../src/utils/validation.js';

describe('assertPositiveInt', () => {
    it('does not throw for a positive integer', () => {
        expect(() => assertPositiveInt(1, 'count')).not.toThrow();
        expect(() => assertPositiveInt(42, 'count')).not.toThrow();
    });

    it('throws ConfigurationError for zero', () => {
        expect(() => assertPositiveInt(0, 'count')).toThrow(ConfigurationError);
    });

    it('throws ConfigurationError for negative numbers', () => {
        expect(() => assertPositiveInt(-5, 'count')).toThrow(ConfigurationError);
    });

    it('throws ConfigurationError for non-integers', () => {
        expect(() => assertPositiveInt(1.5, 'count')).toThrow(ConfigurationError);
    });

    it('includes the field name in the error message', () => {
        expect(() => assertPositiveInt(-1, 'pageSize')).toThrow('pageSize must be a positive integer');
    });
});

describe('assertNonNegativeInt', () => {
    it('accepts zero when nonNegative is enabled', () => {
        process.env.TEST_RETRIES = '0';

        expect(env.int('TEST_RETRIES', 3, { nonNegative: true })).toBe(0);
    });

    it('rejects negative values when nonNegative is enabled', () => {
        process.env.TEST_RETRIES = '-1';

        expect(() => env.int('TEST_RETRIES', 3, { nonNegative: true })).toThrow(ConfigurationError);
    });

    it('accepts zero', () => {
        expect(() => assertNonNegativeInt(0, 'count')).not.toThrow();
    });

    it('accepts positive integers', () => {
        expect(() => assertNonNegativeInt(10, 'count')).not.toThrow();
    });

    it('rejects negative integers', () => {
        expect(() => assertNonNegativeInt(-1, 'count')).toThrow(ConfigurationError);
    });

    it('rejects fractional values', () => {
        expect(() => assertNonNegativeInt(1.5, 'count')).toThrow(ConfigurationError);
    });
});

describe('validateNctId', () => {
    it('returns the canonical NCT ID', () => {
        expect(validateNctId(' nct12345678 ')).toBe('NCT12345678');
    });

    it('accepts a valid nctId', () => {
        expect(() => validateNctId('NCT12345678')).not.toThrow();
    });

    it('accepts a valid nctId case-insensitively', () => {
        expect(() => validateNctId('nct12345678')).not.toThrow();
    });

    it('trims surrounding whitespace before validating', () => {
        expect(() => validateNctId('  NCT12345678  ')).not.toThrow();
    });

    it('throws TrialValidationError for an empty string', () => {
        expect(() => validateNctId('')).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for a whitespace-only string', () => {
        expect(() => validateNctId('   ')).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for wrong prefix', () => {
        expect(() => validateNctId('XYZ12345678')).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for wrong digit count', () => {
        expect(() => validateNctId('NCT1234567')).toThrow(TrialValidationError);
        expect(() => validateNctId('NCT123456789')).toThrow(TrialValidationError);
    });

    it('includes the offending value in the error message', () => {
        expect(() => validateNctId('bad-id')).toThrow(
            'Invalid nctId format. Expected: NCT followed by 8 digits. Got: "bad-id"',
        );
    });
});

describe('makeAssertions (assertInteger / assertPattern / assertNonEmptyString branches)', () => {
    const trial = makeAssertions(TrialValidationError);

    it('accepts values inside or on the declared range', () => {
        expect(() => trial.assertInteger(5, 'x', { min: 1, max: 10 })).not.toThrow();
        expect(() => trial.assertInteger(1, 'x', { min: 1 })).not.toThrow();
        expect(() => trial.assertInteger(10, 'x', { max: 10 })).not.toThrow();
    });

    it('rejects with a combined range description when both bounds are set', () => {
        expect(() => trial.assertInteger(0, 'x', { min: 1, max: 10 })).toThrow('x must be an integer >= 1 <= 10');
        expect(() => trial.assertInteger(11, 'x', { min: 1, max: 10 })).toThrow('x must be an integer >= 1 <= 10');
    });

    it('omits the max clause when only a min bound is set', () => {
        expect(() => trial.assertInteger(4, 'x', { min: 5 })).toThrow('x must be an integer >= 5');
    });

    it('omits the min clause when only a max bound is set', () => {
        expect(() => trial.assertInteger(11, 'x', { max: 10 })).toThrow('x must be an integer <= 10');
    });

    it('uses a custom label instead of the auto-generated description', () => {
        expect(() => trial.assertInteger(0, 'x', { min: 1, label: 'at least one' })).toThrow('x must be at least one');
    });

    it('binds assertions to the requested error type', () => {
        const config = makeAssertions(ConfigurationError);

        expect(() => config.assertInteger(1.5, 'x', { min: 1 })).toThrow(ConfigurationError);
        expect(() => trial.assertInteger(1.5, 'x', { min: 1 })).toThrow(TrialValidationError);
    });

    it('exposes fail, assertNonEmptyString and assertPattern helpers', () => {
        expect(() => trial.fail('kaboom')).toThrow(TrialValidationError);

        expect(() => trial.assertNonEmptyString('ok', 'x')).not.toThrow();
        expect(() => trial.assertNonEmptyString('', 'x')).toThrow('x must be a non-empty string');
        expect(() => trial.assertNonEmptyString('   ', 'x')).toThrow('x must be a non-empty string');
        expect(() => trial.assertNonEmptyString(42, 'x')).toThrow('x must be a non-empty string');

        expect(() => trial.assertPattern('NCT12345678', /^NCT\d{8}$/, 'bad')).not.toThrow();
        expect(() => trial.assertPattern('NOPE', /^NCT\d{8}$/, 'bad')).toThrow('bad');
    });
});
