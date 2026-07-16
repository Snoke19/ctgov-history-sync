import {logger} from '../config/logging.js';
import {DEFAULT_RETRY_AFTER_MS, FETCH_TIMEOUT_MS, MAX_RETRIES, RETRY_BASE_DELAY_MS,} from '../config/config.js';
import {TrialFetchError, TrialTimeoutError} from '../error/errors.js';
import {fetch} from 'undici';
import {getRandomProxyDispatcher} from './readyIPs.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const DEFAULT_HEADERS = Object.freeze({
    Accept: 'application/json',
    'User-Agent': 'ClinicalTrialsScraper/1.0',
});

// ─── Backoff / retry-after helpers ─────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter, capped at 30 s.
 * When a Retry-After hint is provided it takes priority.
 *
 * @param {number} attempt      - zero-indexed attempt number
 * @param {number|null} retryAfterMs
 * @returns {number} delay in ms
 */
export function calculateBackoff(attempt, retryAfterMs = null) {
    if (retryAfterMs != null && retryAfterMs > 0) return retryAfterMs;
    const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, 30_000);
}

/**
 * Parses the Retry-After response header into milliseconds.
 * Handles both integer (seconds) and HTTP-date forms.
 *
 * @param {Response} response
 * @returns {number|null}
 */
export function parseRetryAfterHeader(response) {
    const raw = response.headers.get('Retry-After');
    if (!raw) return null;

    const seconds = Number(raw);
    if (!Number.isNaN(seconds)) return seconds * 1000;

    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), DEFAULT_RETRY_AFTER_MS);

    return DEFAULT_RETRY_AFTER_MS;
}

// ─── Low-level fetch ────────────────────────────────────────────────────────────

/**
 * Fires a single HTTP GET. Applies proxy dispatcher when configured.
 * Throws TrialTimeoutError when the request exceeds its timeout, or
 * TrialFetchError for other network error.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.headers]
 * @returns {Promise<Response>}
 */
async function executeFetch(url, options = {}) {
    const proxyEntry = getRandomProxyDispatcher();
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

    const fetchOptions = {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {...DEFAULT_HEADERS, ...options.headers},
        ...(proxyEntry?.dispatcher && {dispatcher: proxyEntry.dispatcher}),
    };

    const startTime = performance.now();

    try {
        const response = await fetch(url, fetchOptions);
        const durationMs = Math.round(performance.now() - startTime);

        logger.debug(
            'Fetched %s | Status: %d | Proxy: %s | Took: %dms',
            url, response.status, proxyEntry?.url ?? 'direct', durationMs
        );

        return response
    } catch (error) {
        const durationMs = Math.round(performance.now() - startTime);
        const isTimeout = error.name === 'AbortError' || error.name === 'TimeoutError';

        logger.warn(
            'Failed %s | Type: %s | Proxy: %s | Took: %dms | Error: %s',
            url, isTimeout ? 'Timeout' : 'Network Error', proxyEntry?.url ?? 'direct', durationMs, error.message
        );

        if (isTimeout) {
            throw new TrialTimeoutError(url, timeoutMs);
        }
        throw new TrialFetchError(url, error, null, true);
    }
}

// ─── Retry orchestration ────────────────────────────────────────────────────────

/**
 * Runs a single fetch attempt and classifies the outcome for the retry loop.
 * Never throws — failures are returned so the caller decides whether to retry.
 *
 * @param {string} url
 * @param {object} options
 * @returns {Promise<
 *   {success: true, response: Response} |
 *   {success: false, error: Error, retryable: boolean, reason: string}
 * >}
 */
async function attemptFetch(url, options) {
    try {
        const response = await executeFetch(url, options);

        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
            return {success: true, response};
        }

        const retryAfterMs = response.status === 429
            ? (parseRetryAfterHeader(response) ?? DEFAULT_RETRY_AFTER_MS)
            : null;

        const error = new TrialFetchError(
            url,
            new Error(`HTTP ${response.status}: ${response.statusText}`),
            response.status,
            true,
        );
        error.retryAfterMs = retryAfterMs;

        return {success: false, error, retryable: true, reason: `Retryable HTTP ${response.status}`};
    } catch (error) {
        const isTimeout = error instanceof TrialTimeoutError;
        return {
            success: false,
            error,
            retryable: isTimeout || Boolean(error.isTransient),
            reason: isTimeout ? 'Timeout' : 'Transient error',
        };
    }
}

/**
 * Executes a fetch with automatic retries for transient failures.
 * Returns the raw Response on success.
 * Throws TrialFetchError after all retries are exhausted, or immediately on a
 * non-retryable failure.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxRetries]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const outcome = await attemptFetch(url, options);

        if (outcome.success) return outcome.response;

        const isLastAttempt = attempt === maxRetries;
        if (!outcome.retryable || isLastAttempt) throw outcome.error;

        const delay = calculateBackoff(attempt, outcome.error.retryAfterMs);
        logger.warn(
            '%s — retrying in %dms (attempt %d/%d) | %s',
            outcome.reason, Math.round(delay), attempt + 1, maxRetries, url,
        );
        await sleep(delay);
    }
}

// ─── Response parsing ────────────────────────────────────────────────────────

/**
 * Parses a JSON response.
 * Throws TrialFetchError for non-ok responses (other than 404 when allow404=true).
 *
 * @param {Response} response
 * @param {string}   url        - for error messages
 * @param {object}   [opts]
 * @param {boolean}  [opts.allow404=false]
 * @returns {Promise<object>}
 */
export async function parseJsonResponse(response, url, {allow404 = false} = {}) {
    if (allow404 && response.status === 404) {
        return null; // caller decides what to do
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new TrialFetchError(
            url,
            new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${text.slice(0, 200)}`),
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
    } catch (parseError) {
        throw new TrialFetchError(
            url,
            new Error(`Invalid JSON: ${parseError.message}`),
            response.status,
            false,
        );
    }
}
