import { ConfigurationError, TrialValidationError } from '../error/errors.js';

type ErrorCtor = new (message: string) => Error;

export interface Assertions {
    fail(message: string): never;

    assertNonEmptyString(value: unknown, name: string): asserts value is string;

    assertPattern(value: string, pattern: RegExp, message: string): void;

    assertInteger(value: number, name: string, opts?: { min?: number; max?: number; label?: string }): void;
}

/**
 * Builds a set of assert helpers bound to a specific error type.
 *
 * Exported so tests can drive every branch (ranges, labels, error classes)
 * through {@link Assertions.assertInteger} directly. Production callers use
 * the ready-made config/trial assertion sets below.
 */
export function makeAssertions(ErrorType: ErrorCtor): Assertions {
    const fail = (message: string): never => {
        throw new ErrorType(message);
    };

    return {
        fail,

        assertNonEmptyString(value: unknown, name: string): asserts value is string {
            if (typeof value !== 'string' || value.trim() === '') {
                fail(`${name} must be a non-empty string`);
            }
        },

        assertPattern(value: string, pattern: RegExp, message: string): void {
            if (!pattern.test(value.trim())) fail(message);
        },

        assertInteger(value: number, name: string, opts: { min?: number; max?: number; label?: string } = {}): void {
            const { min = -Infinity, max = Infinity, label } = opts;
            if (Number.isInteger(value) && value >= min && value <= max) return;

            const description =
                label ??
                (min === 1 && max === Infinity
                    ? 'a positive integer'
                    : `an integer${min !== -Infinity ? ` >= ${min}` : ''}${max !== Infinity ? ` <= ${max}` : ''}`);

            fail(`${name} must be ${description}`);
        },
    };
}

const configAssertions: Assertions = makeAssertions(ConfigurationError);

export function assertPositiveInt(value: number, name: string): void {
    configAssertions.assertInteger(value, name, { min: 1 });
}

const trialAssertions: Assertions = makeAssertions(TrialValidationError);

const NCT_ID_PATTERN = /^NCT\d{8}$/i;

export function validateNctId(value: string): void {
    trialAssertions.assertNonEmptyString(value, 'nctId');
    trialAssertions.assertPattern(
        value,
        NCT_ID_PATTERN,
        `Invalid nctId format. Expected: NCT followed by 8 digits. Got: "${value}"`,
    );
}
