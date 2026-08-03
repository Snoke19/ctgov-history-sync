import {ConfigurationError, TrialValidationError} from '../src/error/errors.js';
import {assertPositiveInt, validateNctId, validatePageSize,} from '../src/utils/validation.js';
import {describe, expect, it} from "@jest/globals";

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

describe('validateNctId', () => {
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
        expect(() => validateNctId('bad-id')).toThrow("Invalid nctId format. Expected: NCT followed by 8 digits. Got: \"bad-id\"");
    });
});

describe('validatePageSize', () => {
    it('accepts a positive integer', () => {
        expect(() => validatePageSize(10)).not.toThrow();
    });

    it('accepts 1 as the minimum valid value', () => {
        expect(() => validatePageSize(1)).not.toThrow();
    });

    it('throws TrialValidationError for zero', () => {
        expect(() => validatePageSize(0)).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for negative numbers', () => {
        expect(() => validatePageSize(-3)).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for non-integers', () => {
        expect(() => validatePageSize(2.5)).toThrow(TrialValidationError);
    });
});