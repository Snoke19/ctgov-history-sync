import {performance} from 'node:perf_hooks';
import {fetch} from 'undici';
import {
    DEFAULT_USER_AGENT,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../config/config.js';
import {logger} from '../config/logging.js';
import {TrialFetchError, TrialTimeoutError} from '../error/errors.js';
import {EndpointManager} from './endpoint/endpointManager.js';
import {drainBody, parseJsonResponse} from './responseBody.js';
import {buildRetryableError, calculateBackoff, classifyError, isIdempotent,} from './retry/retryPolicy.js';

// =============================================================================
// HTTP CLIENT MODULE
// =============================================================================
//
// Thin orchestration layer that composes three things into one resilient
// fetch pipeline. The decision-making and body-handling pieces live in their
// own modules so they can be tested in isolation:
//
//   - retryPolicy.js    → whether/how long to wait before retrying
//   - responseBody.js   → draining bodies and parsing JSON
//   - httpClient.js     → the network call itself and the retry loop (here)
//
// 1. PROXY-AWARE REQUESTS
//    Every request acquires a proxy dispatcher from a single, shared
//    `EndpointManager`. That sharing is load-bearing: the manager owns the
//    per-IP `TokenBucket` limiters, the round-robin cursor, and each proxy's
//    persistent `ProxyAgent` connection pool. Constructing more than one
//    manager fragments the rate limiter (every instance starts full), resets
//    round-robin rotation back to the first endpoint, and leaks a brand new
//    connection pool per instance. Use `createHttpClient()` to get a client
//    wired to its own manager (mainly for tests); the module's default
//    export shares one manager across the whole process.
//
// 2. AUTOMATIC RETRIES WITH EXPONENTIAL BACKOFF
//    Transient failures (HTTP 408/429/5xx, network timeouts, endpoint
//    acquisition timeouts) are retried up to MAX_RETRIES times with jittered
//    exponential backoff, per retryPolicy.js. Non-idempotent methods
//    (POST/PATCH) are NEVER retried unless explicitly overridden.
//
// 3. TIMEOUT BUDGET MANAGEMENT
//    Each request has a single deadline (`timeoutMs`). Proxy acquisition time
//    is subtracted from the fetch budget, so the total elapsed time never
//    exceeds the configured timeout.
//
// 4. CONNECTION HYGIENE
//    Every response body is fully consumed or explicitly canceled before the
//    Response object is discarded, via responseBody.js.
//
// PUBLIC API
// ----------
//   fetchJson(url, options)     →  Default client. Fetches JSON with all
//                                   resilience layers active, sharing one
//                                   EndpointManager for the process.
//   createHttpClient(deps)      →  Builds an independent client with its own
//                                   (or an injected) EndpointManager. Use
//                                   this in tests instead of mocking the
//                                   whole module.
//
// =============================================================================

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
 * Creates an independent HTTP client with its own endpoint pool.
 *
 * The returned `fetchJson` closes over a single `EndpointManager` that is
 * reused for every call made through this client — that's what keeps rate
 * limiting, round-robin rotation, and proxy connection pooling actually
 * working across concurrent and sequential requests alike.
 *
 * @param {object} [dependencies={}]
 * @param {EndpointManager} [dependencies.endpointManager] - Inject a
 *   pre-built (or mock) manager, primarily for tests. Defaults to a manager
 *   built from this module's config constants.
 * @returns {{fetchJson: (url: string, options?: object) => Promise<object|null>}}
 */
export function createHttpClient({ endpointManager } = {}) {
    const manager =
        endpointManager ??
        new EndpointManager({
            useProxy: true,
            useRateLimit: true,
            rateLimitCapacity: RATE_LIMIT_CAPACITY,
            rateLimitWindow: RATE_LIMIT_WINDOW,
        });

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
     *   - TrialTimeoutError                 → The fetch itself timed out.
     *   - EndpointAcquisitionTimeoutError    → No endpoint became available.
     *   - The raw AbortError                → The caller canceled via `options.signal`.
     *   - TrialFetchError                    → Any other network-level failure.
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
        let proxyEntry;
        try {
            proxyEntry = await manager.acquireEndpoint(timeoutMs);
        } catch (error) {
            // Acquisition failures (every proxy busy/rate-limited) previously
            // vanished silently — only the fetch step below was logged.
            logger.warn('Endpoint acquisition failed | URL: %s | Error: %s', url, error.message);
            throw error;
        }

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
            headers: { ...DEFAULT_HEADERS, ...options.headers },
            ...(options.method && { method: options.method }),
            ...(options.body !== undefined && { body: options.body }),
            ...(proxyEntry?.dispatcher && { dispatcher: proxyEntry.dispatcher }),
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

            return { response, proxyUrl };
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
     * Attempts a single fetch and classifies the result for the retry loop.
     *
     * This function NEVER throws. All outcomes — success or failure — are
     * returned as a structured object so the caller (`fetchWithRetry`) can
     * decide whether to retry, abort, or propagate.
     *
     * @param {string} url
     * @param {object} options - Passed through to executeFetch.
     * @returns {Promise<
     *   | {success: true, response: Response}
     *   | {success: false, error: Error, retryable: boolean, reason: string}
     * >}
     */
    async function attemptFetch(url, options) {
        try {
            const { response, proxyUrl } = await executeFetch(url, options);

            // Non-retryable status → immediate success.
            if (!RETRYABLE_STATUS_CODES.has(response.status)) {
                return { success: true, response };
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
            const { isTimeout, reason } = classifyError(error);

            // Defensive: ensure proxyUrl is always present for logging.
            if (!error.proxyUrl) error.proxyUrl = 'unknown';

            return {
                success: false,
                error,
                retryable:
                    (isTimeout && RETRY_ON_TIMEOUT) ||
                    (Boolean(error.isTransient) && RETRY_ON_NETWORK_ERROR),
                reason,
            };
        }
    }

    /**
     * Executes a fetch with automatic retries for transient failures.
     *
     * Retry policy (see retryPolicy.js):
     *   - Idempotent methods (GET/HEAD/PUT/DELETE/OPTIONS): up to MAX_RETRIES.
     *   - Non-idempotent methods (POST/PATCH): no retries unless
     *     `options.idempotent` is explicitly set to true.
     *   - Non-retryable HTTP statuses (4xx except 408/429): fail immediately.
     *   - External abort (caller signal): fail immediately, never retry.
     *
     * On the final failed attempt, the last error is thrown as-is.
     *
     * @param {string} url
     * @param {object} [options={}]
     * @param {string} [options.method='GET'] - HTTP method.
     * @param {number} [options.maxRetries] - Override the global MAX_RETRIES.
     * @param {number} [options.timeoutMs] - Override the global FETCH_TIMEOUT_MS.
     * @param {boolean} [options.idempotent] - Force retry eligibility regardless
     *   of HTTP method.
     * @returns {Promise<Response>}
     * @throws {TrialFetchError|TrialTimeoutError|EndpointAcquisitionTimeoutError}
     *   After all retries are exhausted.
     */
    async function fetchWithRetry(url, options = {}) {
        const method = options.method ?? 'GET';
        const canRetry = isIdempotent(method, options.idempotent);
        const maxRetries = canRetry ? Math.max(0, options.maxRetries ?? MAX_RETRIES) : 0;

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
     * Fetches a URL and returns parsed JSON.
     *
     * Composes the full resilience stack:
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
     * @throws {TrialFetchError|TrialTimeoutError|EndpointAcquisitionTimeoutError}
     *   On failure after all retries.
     */
    async function fetchJson(url, { allow404 = false, ...requestOptions } = {}) {
        const response = await fetchWithRetry(url, requestOptions);
        return parseJsonResponse(response, url, { allow404 });
    }

    return { fetchJson };
}

const defaultClient = createHttpClient();

export const fetchJson = defaultClient.fetchJson;
