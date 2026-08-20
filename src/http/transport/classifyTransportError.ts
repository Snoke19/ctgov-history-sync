import type { TransportErrorClassification } from './httpTransport.js';

export interface TransportErrorPredicates {
    readonly isAbortError: (error: ErrorLike) => boolean;
    readonly isTimeoutError: (error: ErrorLike) => boolean;
    readonly isNetworkError: (error: ErrorLike) => boolean;
}

export function classifyTransportError(
    error: unknown,
    predicates: TransportErrorPredicates,
): TransportErrorClassification {
    if (hasError(error, predicates.isAbortError)) {
        return {
            kind: 'cancelled',
            cause: error,
        };
    }

    if (hasError(error, predicates.isTimeoutError)) {
        return {
            kind: 'timeout',
            cause: error,
        };
    }

    if (hasError(error, predicates.isNetworkError)) {
        return {
            kind: 'network',
            cause: error,
        };
    }

    return {
        kind: 'unknown',
        cause: error,
    };
}

export interface ErrorLike {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
    readonly cause?: unknown;
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

function isErrorLike(value: unknown): value is ErrorLike {
    return value !== null && typeof value === 'object';
}
