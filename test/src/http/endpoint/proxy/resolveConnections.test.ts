import { describe, expect, it } from '@jest/globals';
import { resolveConnections } from '../../../../../src/http/endpoint/proxy/resolveConnections.js';

const POOL_CONFIG = Object.freeze({
    connections: 10,
    maxConnections: 50,
    pipelining: 1,
    keepAliveTimeoutMs: 4000,
    headersTimeoutMs: 30000,
    bodyTimeoutMs: 30000,
    connectTimeoutMs: 5000,
});

describe('resolveConnections', () => {
    describe('formula', () => {
        it('divides concurrency by proxy count', () => {
            expect(resolveConnections(2, 40, POOL_CONFIG)).toBe(20);
        });

        it('rounds up fractional results', () => {
            expect(resolveConnections(3, 61, POOL_CONFIG)).toBe(21);
        });
    });

    describe('clamping', () => {
        it('clamps to minimum when below', () => {
            expect(resolveConnections(100, 50, POOL_CONFIG)).toBe(10);
        });

        it('returns minimum when calculation equals it', () => {
            expect(resolveConnections(2, 20, POOL_CONFIG)).toBe(10);
        });

        it('clamps to maximum when above', () => {
            expect(resolveConnections(1, 500, POOL_CONFIG)).toBe(50);
        });

        it('returns maximum when calculation equals it', () => {
            expect(resolveConnections(2, 100, POOL_CONFIG)).toBe(50);
        });
    });

    describe('zero inputs', () => {
        it('returns default when concurrency is 0', () => {
            expect(resolveConnections(5, 0, POOL_CONFIG)).toBe(10);
        });

        it('returns default when proxy count is 0', () => {
            expect(resolveConnections(0, 100, POOL_CONFIG)).toBe(10);
        });
    });
});
