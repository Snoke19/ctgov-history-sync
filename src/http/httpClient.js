import {fetch} from 'undici';
import {
    BACKOFF_CAP_MS,
    DEFAULT_RETRY_AFTER_MS,
    DEFAULT_USER_AGENT,
    ERROR_BODY_PREVIEW_LENGTH,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    RETRY_AFTER_STATUS_CODES,
    RETRY_BASE_DELAY_MS,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../config/config.js';
import {logger} from '../config/logging.js';
import {TrialFetchError, TrialTimeoutError} from '../error/errors.js';
import {EndpointManager} from './endpoint/endpointManager.js';

// =============================================================================
// HTTP CLIENT MODULE
// =============================================================================
//
// This module provides a resilient HTTP client built on top of `undici` with
// the following capabilities:
//
// 1. PROXY-AWARE REQUESTS
//    Every request acquires a proxy dispatcher from the proxy pool (proxyPool.test.js).
//    The proxy layer handles per-IP rate limiting via TokenBucket, so this module
//    never needs to worry about pacing — it simply asks for a dispatcher and
//    the pool decides when to hand it over.
//
// 2. AUTOMATIC RETRIES WITH EXPONENTIAL BACKOFF
//    Transient failures (HTTP 408/429/5xx, network timeouts) are retried up to
//    MAX_RETRIES times with jittered exponential backoff. Retry-After headers
//    are respected when present. Non-idempotent methods (POST/PATCH) are NEVER
//    retried unless explicitly overridden.
//
// 3. TIMEOUT BUDGET MANAGEMENT
//    Each request has a single deadline (`timeoutMs`). Proxy acquisition time
//    is subtracted from the fetch budget, so the total elapsed time never
//    exceeds the configured timeout.
//
// 4. CONNECTION HYGIENE
//    Every response body is fully consumed or explicitly canceled before the
//    Response object is discarded. This is required by undici to return the
//    underlying TCP connection to the pool.
//
// PUBLIC API
// ----------
//   fetchJson(url, options)  →  Fetches JSON with all resilience layers active.
//
// =============================================================================

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
 * Default request headers merged into every outgoing request.
 * Caller-provided headers in `options.headers` override these values.
 */
const DEFAULT_HEADERS = Object.freeze({
    Accept: 'application/json',
    'User-Agent': DEFAULT_USER_AGENT,
});

/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Used between retry attempts to implement backoff delays.
 *
 * @param {number} ms - Sleep duration in milliseconds.
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
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
 * @param {Response} response - The fetch Response object.
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
 * Determines whether a request method is safe to retry.
 *
 * @param {string} method - HTTP method (e.g. 'GET', 'POST').
 * @param {boolean} [override] - When explicitly provided, overrides the
 *   built-in idempotency list. Use with caution.
 * @returns {boolean}
 */
function isIdempotent(method, override) {
    if (typeof override === 'boolean') return override;
    return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Executes a single HTTP request through the proxy pool.
 *
 * This is the lowest-level function in the module. It:
 *   1. Acquires a proxy dispatcher (may block on TokenBucket pacing).
 *   2. Calculates the remaining time budget after proxy acquisition.
 *   3. Combines the internal timeout signal with any external AbortSignal.
 *   4. Performs the fetch, logs the outcome, and reports proxy health.
 *
 * Throws:
 *   - TrialTimeoutError      → The request or proxy acquisition timed out.
 *   - The raw AbortError     → The caller canceled via `options.signal`.
 *   - TrialFetchError        → Any other network-level failure.
 *
 * @param {string} url - Target URL.
 * @param {object} [options={}] - Request options.
 * @param {string} [options.method='GET'] - HTTP method.
 * @param {BodyInit} [options.body] - Request body.
 * @param {number} [options.timeoutMs] - Total time budget for proxy
 *   acquisition + fetch. Defaults to FETCH_TIMEOUT_MS.
 * @param {object} [options.headers] - Additional headers merged with defaults.
 * @param {AbortSignal} [options.signal] - External cancellation signal.
 *   Combined with the internal timeout via AbortSignal.any().
 * @returns {Promise<{response: Response, proxyUrl: string}>} The fetch
 *   Response and the proxy URL that served it (or 'direct' if none).
 */
async function executeFetch(url, options = {}) {
    // Total time budget for the entire operation (acquire + fetch).
    const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    // Step 1: Acquire a rate-limited proxy dispatcher.
    // This may wait if the proxy's TokenBucket is empty.
    const endpointManager = new EndpointManager({
        useProxy: true,
        useRateLimit: true,
        rateLimitCapacity: RATE_LIMIT_CAPACITY,
        rateLimitWindow: RATE_LIMIT_WINDOW
    });
    const proxyEntry = await endpointManager.acquireEndpoint(timeoutMs);
    const proxyUrl = proxyEntry?.url ?? 'direct';

    // Step 2: Calculate how much time is left for the actual HTTP request.
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
        // Proxy acquisition consumed the entire budget.
        throw new TrialTimeoutError(url, timeoutMs);
    }

    // Step 3: Build the abort signal.
    // The internal timeout must not outlive the overall deadline.
    const timeoutSignal = AbortSignal.timeout(remainingMs);
    const signal = options.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

    // Step 4: Assemble fetch options.
    const fetchOptions = {
        signal,
        headers: {...DEFAULT_HEADERS, ...options.headers},
        ...(options.method && {method: options.method}),
        ...(options.body !== undefined && {body: options.body}),
        ...(proxyEntry?.dispatcher && {dispatcher: proxyEntry.dispatcher}),
    };

    const startTime = performance.now();

    // Step 5: Execute and classify the outcome.
    try {
        const response = await fetch(url, fetchOptions);
        const durationMs = Math.round(performance.now() - startTime);

        logger.debug(
            'Fetched %s | Status: %d | Proxy: %s | Took: %dms',
            url,
            response.status,
            proxyUrl,
            durationMs,
        );

        return {response, proxyUrl};
    } catch (error) {
        const durationMs = Math.round(performance.now() - startTime);

        // Distinguish three classes of fetch failure:
        const isTimeout = error.name === 'TimeoutError';
        const isExternalAbort = !isTimeout && options.signal?.aborted;

        logger.warn(
            'Failed %s | Type: %s | Proxy: %s | Took: %dms | Error: %s',
            url,
            isTimeout ? 'Timeout' : isExternalAbort ? 'Cancelled' : 'Network Error',
            proxyUrl,
            durationMs,
            error.message,
        );

        // Attach proxyUrl so upstream retry logic can log which proxy failed.
        error.proxyUrl = proxyUrl;

        // Re-throw as domain-specific errors.
        if (isTimeout) {
            const timeoutErr = new TrialTimeoutError(url, timeoutMs);
            timeoutErr.proxyUrl = proxyUrl;
            throw timeoutErr;
        }
        if (isExternalAbort) {
            // Caller explicitly canceled — propagate as-is, never retry.
            throw error;
        }

        // Generic network error (DNS, TCP reset, TLS failure, etc.).
        const fetchErr = new TrialFetchError(url, error, null, true);
        fetchErr.proxyUrl = proxyUrl;
        throw fetchErr;
    }
}

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
async function drainBody(response) {
    try {
        await response.body?.cancel();
    } catch {
        // Already closed or errored — safe to ignore.
    }
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
function buildRetryableError(url, response, proxyUrl) {
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
 * Attempts a single fetch and classifies the result for the retry loop.
 *
 * This function NEVER throws. All outcomes — success or failure — are returned
 * as a structured object so the caller (`fetchWithRetry`) can decide whether
 * to retry, abort, or propagate.
 *
 * @param {string} url
 * @typedef {Error} RetryableError
 * @property {number} [retryAfterMs] - Parsed Retry-After header (ms).
 * @property {string} [proxyUrl] - Proxy that produced this error.
 * @param {object} options - Passed through to executeFetch.
 * @returns {Promise<
 *   | {success: true, response: Response}
 *   | {success: false, error: RetryableError, retryable: boolean, reason: string}
 * >}
 */
async function attemptFetch(url, options) {
    try {
        const {response, proxyUrl} = await executeFetch(url, options);

        // Non-retryable status → immediate success.
        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
            return {success: true, response};
        }

        // Retryable status (408, 429, 5xx).
        // MUST drain the body before discarding the response, otherwise
        // undici cannot reuse the connection.
        await drainBody(response);
        const error = buildRetryableError(url, response, proxyUrl);

        return {
            success: false,
            error,
            retryable: true,
            reason: `Retryable HTTP ${response.status}`,
        };
    } catch (error) {
        // executeFetch threw — classify whether this failure is retryable.
        const isTimeout =
            error instanceof TrialTimeoutError || error.message?.includes('TokenBucket timeout');

        // Defensive: ensure proxyUrl is always present for logging.
        if (!error.proxyUrl) error.proxyUrl = 'unknown';

        return {
            success: false,
            error,
            retryable:
                (isTimeout && RETRY_ON_TIMEOUT) ||
                (Boolean(error.isTransient) && RETRY_ON_NETWORK_ERROR),
            reason: isTimeout ? 'Timeout' : 'Transient error',
        };
    }
}

/**
 * Executes a fetch with automatic retries for transient failures.
 *
 * Retry policy:
 *   - Idempotent methods (GET/HEAD/PUT/DELETE/OPTIONS): up to MAX_RETRIES.
 *   - Non-idempotent methods (POST/PATCH): no retries unless
 *     `options.idempotent` is explicitly set to true.
 *   - Non-retryable HTTP statuses (4xx except 408/429): fail immediately.
 *   - External abort (caller signal): fail immediately, never retry.
 *
 * On the final failed attempt, the last error is thrown as-is.
 *
 * @param {string} url
 * @param {object} [options={}]\
 * @param {string} [options.method='GET'] - HTTP method.
 * @param {number} [options.maxRetries] - Override the global MAX_RETRIES.
 * @param {number} [options.timeoutMs] - Override the global FETCH_TIMEOUT_MS.
 * @param {boolean} [options.idempotent] - Force retry eligibility regardless
 *   of HTTP method.
 * @returns {Promise<Response>}
 * @throws {TrialFetchError|TrialTimeoutError} After all retries are exhausted.
 */
async function fetchWithRetry(url, options = {}) {
    const method = options.method ?? 'GET';
    const canRetry = isIdempotent(method, options.idempotent);
    const maxRetries = canRetry ? (options.maxRetries ?? MAX_RETRIES) : 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const outcome = await attemptFetch(url, options);

        if (outcome.success) return outcome.response;

        const isLastAttempt = attempt === maxRetries;

        // Non-retryable failure or final attempt → propagate the error.
        if (!outcome.retryable || isLastAttempt) throw outcome.error;

        // Wait before the next attempt.
        const delay = calculateBackoff(attempt, outcome.error.retryAfterMs);

        logger.warn(
            '%s - retrying in %dms (attempt %d/%d) | Proxy: %s | URL: %s',
            outcome.reason,
            Math.round(delay),
            attempt + 1,
            maxRetries,
            outcome.error.proxyUrl,
            url,
        );

        await sleep(delay);
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
async function parseJsonResponse(response, url, {allow404 = false} = {}) {
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

/**
 * Fetches a URL and returns parsed JSON.
 *
 * This is the single entry point for all HTTP requests in the application.
 * It composes the full resilience stack:
 *
 *   Proxy pacing  →  Fetch  →  Retry/backoff  →  JSON parse  →  Body cleanup
 *
 * The caller never needs to think about connection cleanup, proxy rotation,
 * or retry logic — everything is handled internally.
 *
 * @param {string} url - Target URL.
 * @param {object} [options={}] - Request options. All properties except
 *   `allow404` are forwarded to the underlying fetch and retry logic.
 * @param {boolean} [options.allow404=false] - Return null on 404 instead
 *   of throwing.
 * @param {string} [options.method='GET'] - HTTP method.
 * @param {BodyInit} [options.body] - Request body.
 * @param {object} [options.headers] - Additional headers.
 * @param {number} [options.timeoutMs] - Per-request timeout override.
 * @param {number} [options.maxRetries] - Per-request retry limit override.
 * @param {boolean} [options.idempotent] - Force retry eligibility regardless
 *   of HTTP method.
 * @param {AbortSignal} [options.signal] - External cancellation.
 * @returns {Promise<object|null>} Parsed JSON, or null for 404 (when allowed)
 *   or 204 No Content.
 * @throws {TrialFetchError|TrialTimeoutError} On failure after all retries.
 */
export async function fetchJson(url, {allow404 = false, ...requestOptions} = {}) {
    const response = await fetchWithRetry(url, requestOptions);
    return parseJsonResponse(response, url, {allow404});
}
