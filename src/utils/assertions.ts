type ErrorCtor = new (message: string) => Error;

export type Assertions = {
    fail(message: string): never;
    assertNonEmptyString(value: unknown, name: string): asserts value is string;
    assertPattern(value: string, pattern: RegExp, message: string): void;
    assertInteger(value: number, name: string, opts?: { min?: number; max?: number; label?: string }): void;
};

export function makeAssertions(ErrorType: ErrorCtor): Assertions {
    function fail(message: string): never {
        throw new ErrorType(message);
    }

    return {
        fail,

        assertNonEmptyString(value: unknown, name: string): asserts value is string {
            if (typeof value !== 'string' || value.trim() === '') {
                fail(`${name} must be a non-empty string`);
            }
        },

        assertPattern(value: string, pattern: RegExp, message: string): void {
            if (!pattern.test(value)) {
                fail(message);
            }
        },

        assertInteger(value: number, name: string, opts: { min?: number; max?: number; label?: string } = {}): void {
            const { min = -Infinity, max = Infinity, label } = opts;

            if (Number.isInteger(value) && value >= min && value <= max) return;

            const description =
                label ?? `an integer${min !== -Infinity ? ` >= ${min}` : ''}${max !== Infinity ? ` <= ${max}` : ''}`;

            fail(`${name} must be ${description}`);
        },
    };
}
