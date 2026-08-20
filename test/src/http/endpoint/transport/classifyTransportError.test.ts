import { describe, expect, it } from '@jest/globals';
import {
    classifyTransportError,
    type TransportErrorPredicates,
} from '../../../../../src/http/transport/classifyTransportError.js';

describe('classifyTransportError', () => {
    const predicates: TransportErrorPredicates = {
        isAbortError: (error) => error.code === 'ABORT',
        isTimeoutError: (error) => error.code === 'TIMEOUT',
        isNetworkError: (error) => error.code === 'NETWORK',
    };

    it('classifies abort errors as cancelled', () => {
        const error = Object.assign(new Error('aborted'), { code: 'ABORT' });

        expect(classifyTransportError(error, predicates)).toEqual({
            kind: 'cancelled',
            cause: error,
        });
    });

    it('classifies timeout errors as timeout', () => {
        const error = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });

        expect(classifyTransportError(error, predicates)).toEqual({
            kind: 'timeout',
            cause: error,
        });
    });

    it('classifies network errors as network', () => {
        const error = Object.assign(new Error('network failure'), { code: 'NETWORK' });

        expect(classifyTransportError(error, predicates)).toEqual({
            kind: 'network',
            cause: error,
        });
    });

    it('classifies unrecognized errors as unknown', () => {
        const error = new TypeError('unexpected failure');

        expect(classifyTransportError(error, predicates)).toEqual({
            kind: 'unknown',
            cause: error,
        });
    });

    it('returns the original error as the cause', () => {
        const error = Object.assign(new Error('failure'), { code: 'NETWORK' });

        const result = classifyTransportError(error, predicates);

        expect(result.cause).toBe(error);
    });

    it('traverses the cause chain', () => {
        const cause = Object.assign(new Error('network failure'), {
            code: 'NETWORK',
        });

        const error = new Error('fetch failed');
        error.cause = cause;

        expect(classifyTransportError(error, predicates)).toEqual({
            kind: 'network',
            cause: error,
        });
    });

    it('handles cycles in the cause chain without looping', () => {
        const first = new Error('first');
        const second = new Error('second');

        first.cause = second;
        second.cause = first;

        expect(classifyTransportError(first, predicates)).toEqual({
            kind: 'unknown',
            cause: first,
        });
    });
});
