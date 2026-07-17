import {logger} from '../config/logging.js';
import {DEFAULT_RETRY_AFTER_MS, FETCH_TIMEOUT_MS, MAX_RETRIES, RETRY_BASE_DELAY_MS,} from '../config/config.js';
import {TrialFetchError, TrialTimeoutError} from '../error/errors.js';
import {fetch} from 'undici';
import {acquireProxyDispatcher} from './readyIPs.js';

export const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

// Methods safe to retry automatically without risking duplicate side effects.
// POST/PATCH are excluded by default — pass {idempotent: true} to override
// for a specific call if you know the endpoint is safe to repeat.
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

const DEFAULT_HEADERS = Object.freeze({
    Accept: 'application/json',
    'User-Agent': 'ClinicalTrialsScraper/1.0',
});

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

function isIdempotent(method, override) {
    if (typeof override === 'boolean') return override;
    return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Fires a single HTTP request. Applies proxy dispatcher when configured.
 * `acquireProxyDispatcher` also paces the request against that proxy's
 * token bucket, so this call may await briefly instead of firing immediately.
 *
 * Throws TrialTimeoutError on internal timeout, the original abort error
 * unwrapped when the caller's own `options.signal` was cancelled (so it is
 * never mistaken for a retryable failure), or TrialFetchError for any other
 * network error.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {BodyInit} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.headers]
 * @param {AbortSignal} [options.signal] - external cancellation, combined with the internal timeout
 * @returns {Promise<Response>}
 */
async function executeFetch(url, options = {}) {
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    // Acquire proxy with remaining time from the overall budget
    const proxyEntry = await acquireProxyDispatcher(timeoutMs);
    const proxyUrl = proxyEntry?.url ?? 'direct';

    const remainingMs = deadline - Date.now();
    const fetchTimeoutMs = Math.max(remainingMs, 1000);

    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    const signal = options.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

    const fetchOptions = {
        signal,
        headers: {...DEFAULT_HEADERS, ...options.headers},
        ...(options.method && {method: options.method}),
        ...(options.body !== undefined && {body: options.body}),
        ...(proxyEntry?.dispatcher && {dispatcher: proxyEntry.dispatcher}),
    };

    const startTime = performance.now();

    try {
        const response = await fetch(url, fetchOptions);
        const durationMs = Math.round(performance.now() - startTime);

        logger.debug(
            'Fetched %s | Status: %d | Proxy: %s | Took: %dms',
            url,
            response.status,
            proxyUrl,
            durationMs
        );

        return {response, proxyUrl};
    } catch (error) {
        const durationMs = Math.round(performance.now() - startTime);
        const isTimeout = error.name === 'TimeoutError';
        const isExternalAbort = !isTimeout && options.signal?.aborted;

        logger.warn(
            'Failed %s | Type: %s | Proxy: %s | Took: %dms | Error: %s',
            url,
            isTimeout ? 'Timeout' : isExternalAbort ? 'Cancelled' : 'Network Error',
            proxyUrl,
            durationMs,
            error.message
        );

        // Attach proxyUrl to every error so upstream logging can see it
        error.proxyUrl = proxyUrl;

        if (isTimeout) {
            throw new TrialTimeoutError(url, timeoutMs);
        }
        if (isExternalAbort) {
            throw error; // caller cancelled — propagate as-is, never retry this
        }
        throw new TrialFetchError(url, error, null, true);
    }
}

/**
 * Safely discards a response body that will never be consumed downstream.
 * Undici (and Node's built-in fetch, which runs on Undici) requires the body
 * to be either read or cancelled before the underlying connection is
 * returned to the pool — see https://undici.nodejs.org/ "Specification
 * Compliance". Swallow cancel errors: the body may already be closed.
 *
 * Kept private on purpose: every path in this module that receives a
 * Response is responsible for calling this itself, so callers in other
 * files never need to know it exists.
 *
 * @param {Response} response
 */
async function drainBody(response) {
    try {
        await response.body?.cancel();
    } catch {
        // already closed/errored — nothing to do
    }
}

/**
 * Builds the TrialFetchError for a retryable HTTP status, attaching a
 * Retry-After hint (429 only) for calculateBackoff to prioritize.
 *
 * @param {string} url
 * @param {string} proxyUrl
 * @param {Response} response
 * @returns {TrialFetchError}
 */
function buildRetryableError(url, response, proxyUrl) {
    const retryAfterMs = response.status === 429
        ? (parseRetryAfterHeader(response) ?? DEFAULT_RETRY_AFTER_MS)
        : null;

    const error = new TrialFetchError(
        url,
        new Error(`HTTP ${response.status}: ${response.statusText}`),
        response.status,
        true
    );
    error.retryAfterMs = retryAfterMs;
    error.proxyUrl = proxyUrl;

    return error;
}

/**
 * Runs a single fetch attempt and classifies the outcome for the retry loop.
 * Never throws — failures are returned so the caller decides whether to retry.
 * Guarantees the response body is drained on every retryable path.
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
        const {response, proxyUrl} = await executeFetch(url, options);

        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
            return {success: true, response};
        }

        await drainBody(response);
        const error = buildRetryableError(url, response, proxyUrl);

        return {success: false, error, retryable: true, reason: `Retryable HTTP ${response.status}`};
    } catch (error) {
        const isTimeout = error instanceof TrialTimeoutError;
        // If proxyUrl wasn't attached (shouldn't happen), default to unknown
        if (!error.proxyUrl) error.proxyUrl = 'unknown';

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
 * Returns the raw Response on success — kept internal (not exported) since
 * every caller must be paired with body handling; `fetchJson` is the public
 * entry point that guarantees this. Retries are skipped entirely for
 * non-idempotent methods (POST/PATCH) unless `options.idempotent` is set.
 *
 * Throws TrialFetchError after all retries are exhausted, or immediately on
 * a non-retryable failure.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxRetries]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.idempotent]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
    const method = options.method ?? 'GET';
    const canRetry = isIdempotent(method, options.idempotent);
    const maxRetries = canRetry ? (options.maxRetries ?? MAX_RETRIES) : 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const outcome = await attemptFetch(url, options);

        if (outcome.success) return outcome.response;

        const isLastAttempt = attempt === maxRetries;
        if (!outcome.retryable || isLastAttempt) throw outcome.error;

        const delay = calculateBackoff(attempt, outcome.error.retryAfterMs);

        logger.warn(
            '%s - retrying in %dms (attempt %d/%d) | Proxy: %s | URL: %s',
            outcome.reason,
            Math.round(delay),
            attempt + 1,
            maxRetries,
            outcome.error.proxyUrl,
            url
        );

        await sleep(delay);
    }
}

/**
 * Parses a JSON response. Guarantees the body is drained on every path,
 * including the allow404 short-circuit and the 204 No Content case.
 * Kept private — only reachable through `fetchJson`.
 *
 * @param {Response} response
 * @param {string}   url        - for error messages
 * @param {object}   [opts]
 * @param {boolean}  [opts.allow404=false]
 * @returns {Promise<object|null>}
 */
async function parseJsonResponse(response, url, {allow404 = false} = {}) {
    if (allow404 && response.status === 404) {
        await drainBody(response);
        return null; // caller decides what to do
    }

    if (response.status === 204) {
        await drainBody(response); // no content by definition, but be defensive
        return null;
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new TrialFetchError(
            url,
            new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${text.slice(0, 200)}`),
            response.status,
            RETRYABLE_STATUS_CODES.has(response.status)
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
            false
        );
    }
}

/**
 * Fetches a URL and returns parsed JSON, with retry/backoff and rate-limit
 * pacing baked in. This is the only function this module exports for making
 * requests — it always fully consumes or cancels the response body, so
 * calling code never has to think about connection cleanup.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {string} [requestOptions.method='GET']
 * @param {BodyInit} [requestOptions.body]
 * @param {object} [requestOptions.headers]
 * @param {number} [requestOptions.timeoutMs]
 * @param {number} [requestOptions.maxRetries]
 * @param {boolean} [requestOptions.idempotent]      - force retry on/off regardless of method
 * @param {boolean} [options.allow404=false]  - return null instead of throwing on 404
 * @param {AbortSignal} [requestOptions.signal]      - external cancellation
 * @returns {Promise<object|null>}
 */
export async function fetchJson(url, {allow404 = false, ...requestOptions} = {}) {
    const response = await fetchWithRetry(url, requestOptions);
    return parseJsonResponse(response, url, {allow404});
}
