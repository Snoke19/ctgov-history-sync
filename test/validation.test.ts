import {ConfigurationError, TrialValidationError} from '../src/error/errors.js';
import {
    assertPositiveInt,
    SearchParams,
    validateGeoDecay,
    validateGeoFilter,
    validateNctId,
    validatePageSize,
    validateSearchParams,
} from '../src/utils/validation.js';
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
        expect(() => validateNctId('bad-id')).toThrow("id must start with NCT prefix! id: \"bad-id\"");
    });
});

describe('validateGeoFilter', () => {
    it('accepts a valid distance filter without unit', () => {
        expect(() => validateGeoFilter('distance(40.7,-74.0,10)')).not.toThrow();
    });

    it('accepts a valid distance filter with km unit', () => {
        expect(() => validateGeoFilter('distance(40.7,-74.0,10km)')).not.toThrow();
    });

    it('accepts a valid distance filter with mi unit', () => {
        expect(() => validateGeoFilter('distance(-40.7,74.0,10.5mi)')).not.toThrow();
    });

    it('throws TrialValidationError for malformed input', () => {
        expect(() => validateGeoFilter('distance(40.7,74.0)')).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for non-string input', () => {
        // @ts-expect-error testing runtime guard against non-string input
        expect(() => validateGeoFilter(123)).toThrow(TrialValidationError);
    });

    it('uses the default paramName "filter.geo" in the error message', () => {
        expect(() => validateGeoFilter('invalid')).toThrow(/Invalid filter\.geo format/);
    });

    it('uses a custom paramName in the error message when provided', () => {
        expect(() => validateGeoFilter('invalid', 'postFilter.geo')).toThrow(/Invalid postFilter\.geo format/);
    });
});

describe('validateGeoDecay', () => {
    it('accepts a valid gauss decay string', () => {
        expect(() => validateGeoDecay('func:gauss,scale:10km,offset:5km,decay:0.5')).not.toThrow();
    });

    it('accepts a valid exp decay string', () => {
        expect(() => validateGeoDecay('func:exp,scale:1.5mi,offset:0mi,decay:1')).not.toThrow();
    });

    it('accepts a valid linear decay string', () => {
        expect(() => validateGeoDecay('func:linear,scale:2km,offset:1km,decay:0.9')).not.toThrow();
    });

    it('throws TrialValidationError for an invalid func value', () => {
        expect(() => validateGeoDecay('func:cubic,scale:10km,offset:5km,decay:0.5')).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError when scale/offset are missing units', () => {
        expect(() => validateGeoDecay('func:gauss,scale:10,offset:5,decay:0.5')).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for undefined', () => {
        // @ts-expect-error testing runtime guard against undefined
        expect(() => validateGeoDecay(undefined)).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError for null', () => {
        // @ts-expect-error testing runtime guard against null
        expect(() => validateGeoDecay(null)).toThrow(TrialValidationError);
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

describe('validateSearchParams', () => {
    it('does not throw for an empty params object', () => {
        expect(() => validateSearchParams({})).not.toThrow();
    });

    it('does not throw when all provided fields are valid', () => {
        const params: SearchParams = {
            pageSize: 20,
            'filter.geo': 'distance(1,2,3km)',
            'postFilter.geo': 'distance(4,5,6mi)',
            geoDecay: 'func:linear,scale:1km,offset:1km,decay:1',
        };
        expect(() => validateSearchParams(params)).not.toThrow();
    });

    it('ignores unrelated extra keys', () => {
        const params: SearchParams = {pageSize: 5, someOtherField: 'anything'};
        expect(() => validateSearchParams(params)).not.toThrow();
    });

    it('throws TrialValidationError when pageSize is invalid', () => {
        expect(() => validateSearchParams({pageSize: -1})).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError when filter.geo is invalid', () => {
        expect(() => validateSearchParams({'filter.geo': 'nope'})).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError when postFilter.geo is invalid', () => {
        expect(() => validateSearchParams({'postFilter.geo': 'nope'})).toThrow(TrialValidationError);
    });

    it('throws TrialValidationError when geoDecay is invalid', () => {
        expect(() => validateSearchParams({geoDecay: 'nope'})).toThrow(TrialValidationError);
    });

    it('validates all provided fields, not just the first invalid one found in isolation', () => {
        // pageSize is invalid, filter.geo is valid — should still throw due to pageSize
        expect(() =>
            validateSearchParams({pageSize: 0, 'filter.geo': 'distance(1,2,3)'}),
        ).toThrow(TrialValidationError);
    });
});