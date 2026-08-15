import { createLogger } from '../config/logging.js';
import { ApiResponseValidationError } from '../error/errors.js';
import { HttpResponse } from './transport/httpTransport.js';

const logger = createLogger(import.meta.url);

/**
 * Safely drains and discards an HTTP response body.
 *
 * Must be called whenever a response is not consumed
 * (e.g. 204, early return) to prevent connection leaks
 * in keep-alive connection pools.
 */
export async function drainBody(response: HttpResponse): Promise<void> {
    if (!response?.discard) {
        return;
    }

    try {
        await response.discard();
    } catch (error: unknown) {
        logger.debug({ err: error, status: response.status }, 'Failed to drain HTTP response body');
        // Response was already closed or failed while draining.
    }
}

/**
 * Parses the body of a successful HTTP response as JSON.
 *
 * Preconditions:
 * - response.ok === true
 *
 * Behavior:
 * - 204 No Content → returns null.
 * - Unexpected Content-Type → logs a warning but still attempts parsing.
 * - Invalid JSON → throws a non-transient TrialFetchError.
 */
export async function parseOkResponseBody(response: HttpResponse, url: string): Promise<unknown | null> {
    if (!response.ok) {
        throw new ApiResponseValidationError(url, `Expected OK response, got HTTP ${response.status}`);
    }

    if (response.status === 204) {
        await drainBody(response);
        return null;
    }

    warnOnUnexpectedContentType(response, url);

    try {
        return await response.json();
    } catch (error: unknown) {
        await drainBody(response);

        const cause = error instanceof Error ? error : new Error(String(error));

        throw new ApiResponseValidationError(url, `Invalid JSON response: ${cause.message}`, { cause });
    }
}

function warnOnUnexpectedContentType(response: HttpResponse, url: string): void {
    const contentType = response.headers.get('Content-Type') ?? '';

    if (!contentType.includes('application/json')) {
        logger.warn({ url: safeHttpUrl(url), contentType }, 'Unexpected HTTP response Content-Type');
    }
}

function safeHttpUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return '<invalid URL>';
    }
}
