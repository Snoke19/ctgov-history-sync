import { describe, expect, test } from '@jest/globals';
import { resolveConnections } from '../../../../../src/http/endpoint/proxy/resolveConnections.js';

const poolConfig = {
    connections: 10,
    maxConnections: 50,
    pipelining: 1,
    keepAliveTimeout: 4000,
    headersTimeout: 30000,
    bodyTimeout: 30000,
    connectTimeout: 5000,
};

describe('resolveConnections', () => {
    test('returns default connections when concurrency is 0', () => {
        expect(resolveConnections(5, 0, poolConfig)).toBe(10);
    });

    test('returns default connections when proxy count is 0', () => {
        expect(resolveConnections(0, 100, poolConfig)).toBe(10);
    });

    test('returns required connections per proxy', () => {
        expect(resolveConnections(2, 40, poolConfig)).toBe(20);
    });

    test('rounds up fractional connections', () => {
        expect(resolveConnections(3, 61, poolConfig)).toBe(21);
    });

    test('does not go below the configured minimum', () => {
        expect(resolveConnections(100, 50, poolConfig)).toBe(10);
    });

    test('returns the configured minimum when exactly at the minimum', () => {
        expect(resolveConnections(2, 20, poolConfig)).toBe(10);
    });

    test('does not exceed the configured maximum', () => {
        expect(resolveConnections(1, 500, poolConfig)).toBe(50);
    });

    test('returns the configured maximum when exactly at the maximum', () => {
        expect(resolveConnections(2, 100, poolConfig)).toBe(50);
    });
});
