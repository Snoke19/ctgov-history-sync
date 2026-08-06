import { logger } from '../config/logging.js';
import { TrialFetchError } from '../error/errors.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';

/**
 * Safely drains and discards an HTTP response body.
 *
 * Must be called whenever a response is not consumed (e.g. 204, early return)
 * to prevent connection leaks in keep-alive pools.
 */
export async function drainBody(response: HttpResponse): Promise<void> {
    if (!response?.discard) return;
    try {
        await response.discard();
    } catch {
        // Already closed or errored - safe to ignore.
    }
}

/**
 * Parses the body of an ok HTTP response as JSON.
 *
 * Precondition: response.ok === true. Status-code handling (4xx, 5xx) is the
 * responsibility of the caller — this function only deals with the body.
 *
 * - 204 No Content → returns null (body is empty by spec, connection is drained)
 * - Unexpected Content-Type → logs a warning but still attempts to parse
 * - Malformed JSON → throws TrialFetchError(isTransient=false)
 */
export async function parseOkResponseBody(
    response: HttpResponse,
    url: string,
    errorBodyPreviewLength: number,
): Promise<unknown> {
    if (response.status === 204) {
        await drainBody(response);
        return null;
    }

    warnOnUnexpectedContentType(response, url);

    try {
        return await response.json();
    } catch (error: any) {
        await drainBody(response);
        throw new TrialFetchError(
            url,
            new Error(`Invalid JSON response: ${error.message}`),
            response.status,
            false, // JSON parse failure is not transient — retrying won't help
        );
    }
}

function warnOnUnexpectedContentType(response: HttpResponse, url: string): void {
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
        logger.warn('Unexpected Content-Type "%s" for %s', contentType, url);
    }
}
