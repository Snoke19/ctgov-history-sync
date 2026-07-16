import {describe, test} from '@jest/globals';
import assert from 'node:assert/strict';
import {cleanParams} from '../src/http/cleanParams.js';

describe('cleanParams', () => {
    test('should return empty object for empty input', () => {
        const result = cleanParams({});
        assert.deepEqual(result, {});
    });

    test('should return empty object when all values are null or undefined', () => {
        const result = cleanParams({
            nullValue: null,
            undefinedValue: undefined,
            emptyString: '',
            emptyArray: []
        });
        assert.deepEqual(result, {});
    });

    test('should trim string values', () => {
        const result = cleanParams({
            name: '  test  ',
            value: 'hello world  '
        });
        assert.deepEqual(result, {
            name: 'test',
            value: 'hello world'
        });
    });

    test('should remove empty strings after trimming', () => {
        const result = cleanParams({
            name: 'test',
            empty: '   ',
            spaces: '\t\n  '
        });
        assert.deepEqual(result, {
            name: 'test'
        });
    });

    test('should join array values with commas', () => {
        const result = cleanParams({
            fields: ['NCTId', 'Title', 'Status'],
            tags: ['cancer', 'phase2']
        });
        assert.deepEqual(result, {
            fields: 'NCTId,Title,Status',
            tags: 'cancer,phase2'
        });
    });

    test('should ignore empty arrays', () => {
        const result = cleanParams({
            name: 'test',
            emptyArray: []
        });
        assert.deepEqual(result, {
            name: 'test'
        });
    });

    test('should preserve number values', () => {
        const result = cleanParams({
            pageSize: 10,
            count: 0,
            negative: -5
        });
        assert.deepEqual(result, {
            pageSize: 10,
            count: 0,
            negative: -5
        });
    });

    test('should preserve boolean values', () => {
        const result = cleanParams({
            active: true,
            disabled: false
        });
        assert.deepEqual(result, {
            active: true,
            disabled: false
        });
    });

    test('should handle mixed parameter types', () => {
        const result = cleanParams({
            name: '  Clinical Trial  ',
            fields: ['NCTId', 'Title'],
            pageSize: 20,
            active: true,
            nullValue: null,
            emptyString: '',
            emptyArray: []
        });
        assert.deepEqual(result, {
            name: 'Clinical Trial',
            fields: 'NCTId,Title',
            pageSize: 20,
            active: true
        });
    });

    test('should use default empty object when no params provided', () => {
        const result = cleanParams();
        assert.deepEqual(result, {});
    });

    test('should handle nested object values (pass through unchanged)', () => {
        const nestedObj = {key: 'value'};
        const result = cleanParams({
            config: nestedObj
        });
        assert.deepEqual(result, {
            config: nestedObj
        });
    });

    test('should handle special characters in strings', () => {
        const result = cleanParams({
            query: '  AREA[StartDate]RANGE[03/16/2026, 07/18/2026]  ',
            filter: 'distance(40.7128,-74.0060,10km)'
        });
        assert.deepEqual(result, {
            query: 'AREA[StartDate]RANGE[03/16/2026, 07/18/2026]',
            filter: 'distance(40.7128,-74.0060,10km)'
        });
    });
});
