import { describe, expect, it } from '@jest/globals';
import { validateNctId } from '../../../src/api/trialValidation.js';
import { TrialValidationError } from '../../../src/error/errors.js';

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
