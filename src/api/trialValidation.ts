import { TrialValidationError } from '../error/errors.js';
import { Assertions, makeAssertions } from '../utils/assertions.js';

const NCT_ID_PATTERN = /^NCT\d{8}$/;
const trialAssert: Assertions = makeAssertions(TrialValidationError);

export function validateNctId(value: string): string {
    trialAssert.assertNonEmptyString(value, 'nctId');

    const normalized = value.trim().toUpperCase();

    trialAssert.assertPattern(
        normalized,
        NCT_ID_PATTERN,
        `Invalid nctId format. Expected: NCT followed by 8 digits. Got: "${value}"`,
    );

    return normalized;
}
