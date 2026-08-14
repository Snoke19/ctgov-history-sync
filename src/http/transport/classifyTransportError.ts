import type { TransportErrorClassification } from './httpTransport.js';

const TIMEOUT_ERROR_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const ABORT_ERROR_CODES = new Set(['UND_ERR_ABORTED', 'ABORT_ERR']);

export function classifyTransportError(error: unknown): TransportErrorClassification {
    if (hasError(error, isAbortError)) {
        return {
            kind: 'cancelled',
            cause: error,
        };
    }

    if (hasError(error, isTimeoutError)) {
        return {
            kind: 'timeout',
            cause: error,
        };
    }

    return {
        kind: 'network',
        cause: error,
    };
}

function isAbortError(error: ErrorLike): boolean {
    return error.name === 'AbortError' || (typeof error.code === 'string' && ABORT_ERROR_CODES.has(error.code));
}

function isTimeoutError(error: ErrorLike): boolean {
    return typeof error.code === 'string' && TIMEOUT_ERROR_CODES.has(error.code);
}

function hasError(error: unknown, predicate: (error: ErrorLike) => boolean): boolean {
    let current: unknown = error;
    const visited = new Set<unknown>();

    while (isErrorLike(current) && !visited.has(current)) {
        visited.add(current);

        if (predicate(current)) {
            return true;
        }

        current = current.cause;
    }

    return false;
}

interface ErrorLike {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
}

function isErrorLike(value: unknown): value is ErrorLike {
    return value !== null && typeof value === 'object';
}
