import { TransportErrorClassification } from '../httpTransport.js';

/**
 * Error taxonomy for WHATWG fetch (global fetch and undici).
 *
 * Both libraries reject a request whose signal aborted with a DOMException
 * whose `name` is 'AbortError' (undici additionally carries a `code` of
 * 'ABORT_ERR'); anything else that rejects — TypeError from the undici
 * stack, socket failures, etc. — is a network failure.
 */
export function classifyFetchError(error: unknown): TransportErrorClassification {
    if (isFetchAbortError(error)) {
        return { kind: 'cancelled', cause: error };
    }
    return { kind: 'network', cause: error };
}

function isFetchAbortError(error: unknown): boolean {
    if (error !== null && typeof error === 'object') {
        if ('name' in error && error.name === 'AbortError') return true;
        if ('code' in error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') return true;
    }
    return false;
}