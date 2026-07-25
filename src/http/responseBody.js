import {ERROR_BODY_PREVIEW_LENGTH, RETRYABLE_STATUS_CODES} from '../config/config.js';
import {logger} from '../config/logging.js';
import {TrialFetchError} from '../error/errors.js';

/**
 * Cancels the response body stream to release the underlying TCP connection.
 *
 * undici (and Node's built-in fetch, which uses undici) requires that every
 * Response body be either fully read or explicitly canceled before the
 * connection can be returned to the Pool. Skipping this step leaks
 * connections and eventually exhausts the pool.
 *
 * This is a no-op if the body is already closed or errored.
 *
 * @param {Response} response
 * @returns {Promise<void>}
 */
export async function drainBody(response) {
    try {
        await response.body?.cancel();
    } catch {
        // Already closed or errored — safe to ignore.
    }
}

/**
 * Consumes a Response body and parses it as JSON.
 *
 * Special cases:
 *   - 404 + allow404=true → returns null (caller handles missing resource).
 *   - 204 No Content        → returns null.
 *   - Non-2xx status        → throws TrialFetchError with body preview.
 *   - Invalid JSON body       → throws TrialFetchError (non-retryable).
 *
 * The response body is always drained or consumed, satisfying undici's
 * connection-pool requirements.
 *
 * @param {Response} response
 * @param {string} url - For error messages.
 * @param {object} [opts={}]
 * @param {boolean} [opts.allow404=false] - When true, 404 returns null
 *   instead of throwing.
 * @returns {Promise<object|null>} Parsed JSON, or null for 404/204.
 * @throws {TrialFetchError} On HTTP error or JSON parse failure.
 */
export async function parseJsonResponse(response, url, {allow404 = false} = {}) {
    // 404 short-circuit
    if (response.status === 404) {
        logger.debug('HTTP 404 on %s | allow404=%s', url, allow404);
    }

    if (allow404 && response.status === 404) {
        await drainBody(response);
        return null;
    }

    // 204 No Content
    if (response.status === 204) {
        await drainBody(response);
        return null;
    }

    // Any non-2xx status → error with body preview for debugging.
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new TrialFetchError(
            url,
            new Error(
                `HTTP ${response.status}: ${response.statusText}. ` +
                `Body: ${text.slice(0, ERROR_BODY_PREVIEW_LENGTH)}`,
            ),
            response.status,
            RETRYABLE_STATUS_CODES.has(response.status),
        );
    }

    // Warn about unexpected Content-Type, but still attempt to parse.
    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
        logger.warn('Unexpected Content-Type: %s | %s', contentType, url);
    }

    try {
        return await response.json();
    } catch (parseError) {
        throw new TrialFetchError(
            url,
            new Error(`Invalid JSON: ${parseError.message}`),
            response.status,
            false, // non-retryable: the server responded, but body is garbage
        );
    }
}