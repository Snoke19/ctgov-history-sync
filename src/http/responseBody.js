import {ERROR_BODY_PREVIEW_LENGTH, RETRYABLE_STATUS_CODES} from '../config/config.js';
import {logger} from '../config/logging.js';
import {TrialFetchError} from '../error/errors.js';

/**
 * Cancels an unused response body stream so undici can clean up
 * the underlying connection resources.
 *
 * @param {Response} response
 * @returns {Promise<void>}
 */
export async function drainBody(response) {
    if (!response?.body) {
        return;
    }

    try {
        await response.body.cancel();
    } catch {
        // Already closed or errored — safe to ignore.
    }
}

/**
 * Consumes a Response body and parses it as JSON.
 *
 * Special cases:
 *   - 404 + allow404=true → returns null.
 *   - 204 No Content     → returns null.
 *   - Non-2xx status     → throws TrialFetchError with body preview.
 *   - Invalid JSON       → throws TrialFetchError.
 *
 * The response body is always consumed or canceled before the response
 * is discarded, satisfying undici connection-pool requirements.
 *
 * @param {Response} response
 * @param {string} url
 * @param {object} [opts={}]
 * @param {boolean} [opts.allow404=false]
 * @returns {Promise<object|null>}
 * @throws {TrialFetchError}
 */
export async function parseJsonResponse(response, url, {allow404 = false} = {}) {
    if (response.status === 404) {
        logger.debug('HTTP 404 on %s | allow404=%s', url, allow404);
    }

    if (allow404 && response.status === 404) {
        await drainBody(response);
        return null;
    }

    if (response.status === 204) {
        await drainBody(response);
        return null;
    }

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

    const contentType = response.headers.get('Content-Type') ?? '';

    if (!contentType.includes('application/json')) {
        logger.warn('Unexpected Content-Type: %s | %s', contentType, url);
    }

    try {
        return await response.json();
    } catch (error) {
        await drainBody(response);

        throw new TrialFetchError(
            url,
            new Error(`Invalid JSON: ${error.message}`),
            response.status,
            false,
        );
    }
}