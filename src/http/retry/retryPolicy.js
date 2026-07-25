import {
    BACKOFF_CAP_MS,
    DEFAULT_RETRY_AFTER_MS,
    RETRY_AFTER_STATUS_CODES,
    RETRY_BASE_DELAY_MS,
} from '../../config/config.js';
import {EndpointAcquisitionTimeoutError, TrialFetchError, TrialTimeoutError} from '../../error/errors.js';

/**
 * HTTP methods considered safe to retry automatically.
 *
 * GET, HEAD, PUT, DELETE, and OPTIONS are idempotent by definition — repeating
 * them does not risk duplicate side effects on the server. POST and PATCH are
 * deliberately excluded; pass `{idempotent: true}` to a specific call if you
 * know the endpoint is safe to repeat (e.g. an upsert or idempotent POST).
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Determines whether a request method is safe to retry.
 *
 * @param {string} method - HTTP method (e.g. 'GET', 'POST').
 * @param {boolean} [override] - When explicitly provided, overrides the
 *   built-in idempotency list. Use with caution.
 * @returns {boolean}
 */
export function isIdempotent(method, override) {
    if (typeof override === 'boolean') return override;
    return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Calculates the delay before the next retry attempt.
 *
 * Strategy (in priority order):
 *   1. If the server sent a Retry-After header, use that value exactly.
 *   2. Otherwise, use exponential backoff: base × 2^attempt + 50% jitter.
 *   3. Cap the result at BACKOFF_CAP_MS (default 30 s).
 *
 * The jitter prevents "thundering herd" when many requests fail simultaneously
 * and would otherwise retry at the exact same moment.
 *
 * @param {number} attempt - Zero-indexed retry attempt (0 = first retry).
 * @param {number|null} [retryAfterMs] - Parsed Retry-After value from the
 *   server, in milliseconds. Takes precedence over calculated backoff.
 * @returns {number} Delay in milliseconds.
 */
export function calculateBackoff(attempt, retryAfterMs = null) {
    if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;

    const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, BACKOFF_CAP_MS);
}

/**
 * Parses the Retry-After response header into milliseconds.
 *
 * The header may appear in two forms per RFC 9110:
 *   - Integer seconds:  `Retry-After: 120`
 *   - HTTP-date:        `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 *
 * If the value is unparseable, falls back to DEFAULT_RETRY_AFTER_MS.
 *
 * @param {{ headers: { get(name: string): string | null } }} response
 * @returns {number|null} Delay in milliseconds, or null if the header
 *   is absent.
 */
export function parseRetryAfterHeader(response) {
    const raw = response.headers.get('Retry-After');
    if (!raw) return null;

    // Form 1: delay-seconds (integer)
    const seconds = Number(raw);
    if (!Number.isNaN(seconds)) return seconds * 1000;

    // Form 2: HTTP-date
    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), DEFAULT_RETRY_AFTER_MS);

    // Unparseable — use safe default
    return DEFAULT_RETRY_AFTER_MS;
}

/**
 * Constructs a TrialFetchError for a retryable HTTP status code.
 *
 * Attaches:
 *   - `retryAfterMs`  → Parsed Retry-After header (only for codes listed in
 *     RETRY_AFTER_STATUS_CODES, e.g. 429).
 *   - `proxyUrl`        → Which proxy returned the error.
 *
 * @param {string} url - The requested URL.
 * @param {Response} response - The HTTP response.
 * @param {string} proxyUrl - The proxy that produced this response.
 * @returns {TrialFetchError}
 */
export function buildRetryableError(url, response, proxyUrl) {
    const retryAfterMs = RETRY_AFTER_STATUS_CODES.has(response.status)
        ? (parseRetryAfterHeader(response) ?? DEFAULT_RETRY_AFTER_MS)
        : null;

    const error = new TrialFetchError(
        url,
        new Error(`HTTP ${response.status}: ${response.statusText}`),
        response.status,
        true, // isTransient = retryable
    );
    error.retryAfterMs = retryAfterMs;
    error.proxyUrl = proxyUrl;

    return error;
}

/**
 * Classifies a thrown error for retry accounting.
 *
 * Uses `instanceof` rather than string-matching `error.message`, so it keeps
 * working regardless of how an error's message is phrased. In particular,
 * `EndpointManager.acquireEndpoint()` throws `EndpointAcquisitionTimeoutError`
 * when every proxy is busy/rate-limited — that must be recognized as a
 * timeout here for `RETRY_ON_TIMEOUT` to apply to it.
 *
 * @param {unknown} error
 * @returns {{isTimeout: boolean, reason: string}}
 */
export function classifyError(error) {
    if (error instanceof EndpointAcquisitionTimeoutError) {
        return {isTimeout: true, reason: 'Endpoint acquisition timeout'};
    }
    if (error instanceof TrialTimeoutError) {
        return {isTimeout: true, reason: 'Request timeout'};
    }
    return {isTimeout: false, reason: 'Transient error'};
}