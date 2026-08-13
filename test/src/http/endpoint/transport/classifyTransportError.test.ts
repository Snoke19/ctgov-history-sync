import { describe, expect, it } from '@jest/globals';
import { classifyTransportError } from '../../../../../src/http/transport/classifyTransportError.js';

describe('classifyTransportError', () => {
    it.each(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])(
        'classifies %s as timeout',
        (code) => {
            const error = Object.assign(new Error('timeout'), { code });

            expect(classifyTransportError(error)).toEqual({
                kind: 'timeout',
                cause: error,
            });
        },
    );

    it('classifies a wrapped Undici timeout as timeout', () => {
        const cause = Object.assign(new Error('Connect Timeout Error'), {
            name: 'ConnectTimeoutError',
            code: 'UND_ERR_CONNECT_TIMEOUT',
        });

        const error = new TypeError('fetch failed');
        error.cause = cause;

        expect(classifyTransportError(error)).toEqual({
            kind: 'timeout',
            cause: error,
        });
    });

    it('classifies AbortError as cancelled', () => {
        const error = new DOMException('The operation was aborted.', 'AbortError');

        expect(classifyTransportError(error)).toEqual({
            kind: 'cancelled',
            cause: error,
        });
    });

    it('classifies UND_ERR_ABORTED as cancelled', () => {
        const error = Object.assign(new Error('Request aborted'), {
            code: 'UND_ERR_ABORTED',
        });

        expect(classifyTransportError(error)).toEqual({
            kind: 'cancelled',
            cause: error,
        });
    });

    it('classifies unknown errors as network', () => {
        const error = new Error('ECONNRESET');

        expect(classifyTransportError(error)).toEqual({
            kind: 'network',
            cause: error,
        });
    });
});
