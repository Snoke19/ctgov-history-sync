import {describe, test} from '@jest/globals';
import assert from 'node:assert/strict';
import {validateGeoDecay, validateGeoFilter, validatePageSize} from '../src/validators.js';

describe('validatePageSize', () => {
    test('should accept positive integers', () => {
        validatePageSize(1);
        validatePageSize(10);
        validatePageSize(100);
    });

    test('should reject zero', () => {
        assert.throws(() => validatePageSize(0), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
    });

    test('should reject negative integers', () => {
        assert.throws(() => validatePageSize(-1), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
        assert.throws(() => validatePageSize(-100), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
    });

    test('should reject non-integers', () => {
        assert.throws(() => validatePageSize(1.5), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
        assert.throws(() => validatePageSize(10.01), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
    });

    test('should reject strings', () => {
        assert.throws(() => validatePageSize('10'), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
    });

    test('should reject null and undefined', () => {
        assert.throws(() => validatePageSize(null), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
        assert.throws(() => validatePageSize(undefined), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
    });

    test('should reject objects and arrays', () => {
        assert.throws(() => validatePageSize({}), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
        assert.throws(() => validatePageSize([]), {
            name: 'TrialValidationError',
            message: 'pageSize must be a positive integer'
        });
    });
});

describe('validateGeoFilter', () => {
    test('should accept valid distance format with km', () => {
        validateGeoFilter('distance(40.7128,-74.0060,10km)');
        validateGeoFilter('distance(0,0,5.5km)');
    });

    test('should accept valid distance format with mi', () => {
        validateGeoFilter('distance(40.7128,-74.0060,10mi)');
        validateGeoFilter('distance(0,0,5.5mi)');
    });

    test('should accept valid distance format without units', () => {
        validateGeoFilter('distance(40.7128,-74.0060,10)');
        validateGeoFilter('distance(0,0,5.5)');
    });

    test('should accept negative coordinates', () => {
        validateGeoFilter('distance(-40.7128,74.0060,10km)');
        validateGeoFilter('distance(40.7128,-74.0060,10km)');
        validateGeoFilter('distance(-40.7128,-74.0060,10km)');
    });

    test('should use custom paramName in error message', () => {
        assert.throws(() => validateGeoFilter('invalid', 'postFilter.geo'), {
            name: 'TrialValidationError',
            message: /Invalid postFilter\.geo format/
        });
    });

    test('should reject non-string values', () => {
        assert.throws(() => validateGeoFilter(123), {
            name: 'TrialValidationError',
            message: /Invalid filter\.geo format/
        });
        assert.throws(() => validateGeoFilter(null), {
            name: 'TrialValidationError',
            message: /Invalid filter\.geo format/
        });
        assert.throws(() => validateGeoFilter(undefined), {
            name: 'TrialValidationError',
            message: /Invalid filter\.geo format/
        });
    });

    test('should reject malformed distance strings', () => {
        const invalidFormats = [
            'distance(40.7128,-74.0060)', // missing distance
            'distance(40.7128,-74.0060,)', // missing distance value
            'distance(40.7128,)', // missing longitude and distance
            'distance(,)', // all empty
            'distance(40.7128,-74.0060,10,extra)', // too many parameters
            'distance(40.7128 -74.0060 10km)', // missing commas
            'distance[40.7128,-74.0060,10km]', // wrong brackets
            'distance(40.7128,-74.0060,10xyz)', // invalid units
        ];

        invalidFormats.forEach(format => {
            assert.throws(() => validateGeoFilter(format), {
                name: 'TrialValidationError',
                message: /Invalid filter\.geo format/
            });
        });
    });

    test('should reject strings without distance prefix', () => {
        assert.throws(() => validateGeoFilter('40.7128,-74.0060,10km'), {
            name: 'TrialValidationError',
            message: /Invalid filter\.geo format/
        });
    });

    test('should accept leading/trailing whitespace in value', () => {
        validateGeoFilter('  distance(40.7128,-74.0060,10km)  ');
    });
});

describe('validateGeoDecay', () => {
    test('should accept valid gauss function', () => {
        validateGeoDecay('func:gauss,scale:10km,offset:5km,decay:2.5');
        validateGeoDecay('func:gauss,scale:10mi,offset:5mi,decay:2.5');
    });

    test('should accept valid exp function', () => {
        validateGeoDecay('func:exp,scale:10km,offset:5km,decay:2.5');
        validateGeoDecay('func:exp,scale:10mi,offset:5mi,decay:2.5');
    });

    test('should accept valid linear function', () => {
        validateGeoDecay('func:linear,scale:10km,offset:5km,decay:2.5');
        validateGeoDecay('func:linear,scale:10mi,offset:5mi,decay:2.5');
    });

    test('should accept decimal values', () => {
        validateGeoDecay('func:gauss,scale:10.5km,offset:5.25mi,decay:2.75');
    });

    test('should reject non-string values', () => {
        assert.throws(() => validateGeoDecay(123), {
            name: 'TrialValidationError',
            message: 'geoDecay must be a string'
        });
        assert.throws(() => validateGeoDecay(null), {
            name: 'TrialValidationError',
            message: 'geoDecay must be a string'
        });
        assert.throws(() => validateGeoDecay(undefined), {
            name: 'TrialValidationError',
            message: 'geoDecay must be a string'
        });
    });

    test('should reject invalid function types', () => {
        const invalidFunctions = [
            'func:quadratic,scale:10km,offset:5km,decay:2.5',
            'func:log,scale:10km,offset:5km,decay:2.5',
            'func:,scale:10km,offset:5km,decay:2.5'
        ];

        invalidFunctions.forEach(format => {
            assert.throws(() => validateGeoDecay(format), {
                name: 'TrialValidationError',
                message: /Invalid geoDecay format/
            });
        });
    });

    test('should reject malformed parameters', () => {
        const invalidFormats = [
            'func:gauss,scale:10km,offset:5km', // missing decay
            'func:gauss,scale:10km,decay:2.5', // missing offset
            'func:gauss,offset:5km,decay:2.5', // missing scale
            'func:gauss,scale:10km,offset:5km,decay:', // missing decay value
            'func:gauss,scale:km,offset:5km,decay:2.5', // missing scale value
            'func:gauss,scale:10,offset:5,decay:2.5', // missing units
            'func:gauss,scale:10kmx,offset:5km,decay:2.5', // invalid units
        ];

        invalidFormats.forEach(format => {
            assert.throws(() => validateGeoDecay(format), {
                name: 'TrialValidationError',
                message: /Invalid geoDecay format/
            });
        });
    });

    test('should accept leading/trailing whitespace in value', () => {
        validateGeoDecay('  func:gauss,scale:10km,offset:5km,decay:2.5  ');
    });
});
