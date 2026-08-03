import {ConfigurationError, TrialValidationError} from '../error/errors.js';

type ErrorCtor = new (message: string) => Error;

interface Assertions {
    fail(message: string): never;

    assertNonEmptyString(value: unknown, name: string): asserts value is string;

    assertPattern(value: string, pattern: RegExp, message: string): void;

    assertFormat(value: unknown, pattern: RegExp, message: string): void;

    assertInteger(value: number, name: string, opts?: { min?: number; max?: number; label?: string }): void;
}

function makeAssertions(ErrorType: ErrorCtor): Assertions {
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

        assertFormat(value: unknown, pattern: RegExp, message: string): void {
            if (typeof value !== 'string' || !pattern.test(value.trim())) fail(message);
        },

        assertInteger(value: number, name: string, opts: { min?: number; max?: number; label?: string } = {}): void {
            const {min = -Infinity, max = Infinity, label} = opts;
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
    configAssertions.assertInteger(value, name, {min: 1});
}

const trialAssertions: Assertions = makeAssertions(TrialValidationError);

const PATTERNS = {
    nctId: /^NCT\d{8}$/i,
    geo: /^distance\(-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+(\.\d+)?(km|mi)?\)$/,
    geoDecay: /^func:(gauss|exp|linear),scale:(\d+(\.\d+)?(km|mi)),offset:(\d+(\.\d+)?(km|mi)),decay:(\d+(\.\d+)?)$/,
} as const;

export function validateNctId(value: string): void {
    trialAssertions.assertNonEmptyString(value, 'nctId');

    if (!value.trim().toUpperCase().startsWith('NCT', 0)) {
        trialAssertions.fail(`id must start with NCT prefix! id: "${value}"`)
    }

    trialAssertions.assertPattern(
        value,
        PATTERNS.nctId,
        `Invalid nctId format. Expected: NCT followed by 8 digits. Got: "${value}"`,
    );
}

export function validateGeoFilter(value: string, paramName = 'filter.geo'): void {
    trialAssertions.assertFormat(
        value,
        PATTERNS.geo,
        `Invalid ${paramName} format. Expected: distance(lat,lon,dist)[km|mi]. Got: "${value}"`,
    );
}

export function validateGeoDecay(value: string): void {
    trialAssertions.assertFormat(
        value,
        PATTERNS.geoDecay,
        `Invalid geoDecay format. Expected: func:(gauss|exp|linear),scale:<dist><km|mi>,offset:<dist><km|mi>,decay:<number>. Got: "${value}"`,
    );
}

export function validatePageSize(value: number): void {
    trialAssertions.assertInteger(value, 'pageSize', {min: 1});
}

export interface SearchParams {
    pageSize?: number;
    'filter.geo'?: string;
    'postFilter.geo'?: string;
    geoDecay?: string;

    [key: string]: unknown;
}

const searchParamValidators: Record<string, (params: SearchParams) => void> = {
    pageSize: (p) => validatePageSize(p.pageSize as number),
    'filter.geo': (p) => validateGeoFilter(p['filter.geo'] as string, 'filter.geo'),
    'postFilter.geo': (p) => validateGeoFilter(p['postFilter.geo'] as string, 'postFilter.geo'),
    geoDecay: (p) => validateGeoDecay(p.geoDecay as string),
};

export function validateSearchParams(params: SearchParams): void {
    for (const [key, validate] of Object.entries(searchParamValidators)) {
        if (params[key] !== undefined) validate(params);
    }
}