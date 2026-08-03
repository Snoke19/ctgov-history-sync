import {performance} from 'node:perf_hooks';
import {fetch} from 'undici';
import {
    DEFAULT_USER_AGENT,
    ERROR_BODY_PREVIEW_LENGTH,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../config/config.ts';
import {logger} from '../config/logging.js';
import {EndpointAcquisitionTimeoutError, TrialFetchError, TrialTimeoutError} from '../error/errors.js';
import {EndpointManager} from './endpoint/endpointManager.js';
import {drainBody, parseJsonResponse} from './responseBody.js';
import {buildRetryableError, calculateBackoff, classifyError, isIdempotent,} from './retry/retryPolicy.js';
import {setTimeout as sleep} from 'node:timers/promises';

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
 * Creates an independent HTTP client with its own endpoint pool.
 *
 * The returned `fetchJson` closes over a single `EndpointManager` that is
 * reused for every call made through this client — that's what keeps rate
 * limiting, round-robin rotation, and proxy connection pooling actually
 * working across concurrent and sequential requests alike.
 *
 * @param {object} [options]
 * @param {boolean} [options.useProxy=true]
 * @param {string} [options.proxyUrls]
 * @param {number} [options.acquireTimeout]
 * @param {boolean} [options.useRateLimit=true]
 * @param {number} [options.rateLimitCapacity]
 * @param {number} [options.rateLimitWindow]
 * @returns {{fetchJson: (url: string, options?: object) => Promise<object|null>}}
 */
export function createHttpClient(options = {}) {

    const endpointManager = new EndpointManager(options);

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
     * @param {number} [options.deadline] - Absolute request deadline in milliseconds since the Unix epoch. Internal use only.
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
        const deadline = options.deadline ?? (Date.now() + timeoutMs);

        // Step 1: Acquire a rate-limited proxy dispatcher.
        let proxyEntry;
        try {
            const remainingBeforeAcquire = getRemainingTime(deadline, url, timeoutMs);
            proxyEntry = await endpointManager.acquireEndpoint(remainingBeforeAcquire);
        } catch (error) {
            logger.warn(
                'Endpoint acquisition failed | URL: %s | Error: %s',
                url,
                error.message,
            );
            throw error;
        }

        const proxyUrl = proxyEntry?.url ?? 'direct';

        // Step 2: Recalculate remaining time after acquisition.
        const remainingBeforeFetch = getRemainingTime(deadline, url, timeoutMs);

        // Step 3: Build the abort signal.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort(new DOMException('Request timed out', 'TimeoutError'));
        }, remainingBeforeFetch);

        const signal = options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal;

        // Step 4: Assemble fetch options.
        const headers = options.headers
            ? {
                ...DEFAULT_HEADERS,
                ...options.headers,
            }
            : DEFAULT_HEADERS;

        const fetchOptions = {
            signal,
            headers,
        };

        if (options.method) {
            fetchOptions.method = options.method;
        }

        if (options.body !== undefined) {
            fetchOptions.body = options.body;
        }

        if (proxyEntry?.dispatcher) {
            fetchOptions.dispatcher = proxyEntry.dispatcher;
        }

        const startTime = performance.now();

        // Step 5: Execute request.
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

            const transformed = transformFetchError(error, {
                url,
                proxyUrl,
                remainingMs: remainingBeforeFetch,
                timeoutMs,
                signal: options.signal,
            });

            const logMessage = transformed.cause?.message ?? transformed.message;
            const failureType =
                transformed instanceof TrialTimeoutError ? 'Timeout' : transformed === error ? 'Cancelled' : 'Network Error';

            logger.warn(
                'Failed %s | Type: %s | Proxy: %s | Took: %dms | Error: %s',
                url,
                failureType,
                proxyUrl,
                durationMs,
                logMessage,
            );

            throw transformed;
        } finally {
            clearTimeout(timeoutId);
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
     *   | {
     *       success: false,
     *       error: TrialFetchError | TrialTimeoutError | EndpointAcquisitionTimeoutError | Error,
     *       retryable: boolean,
     *       reason: string,
     *     }
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
            const {
                isTimeout,
                isCancelled,
                reason,
            } = classifyError(error);

            return {
                success: false,
                error,
                retryable:
                    !isCancelled &&
                    ((isTimeout && RETRY_ON_TIMEOUT) || (Boolean(error.isTransient) && RETRY_ON_NETWORK_ERROR)),
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

        const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const outcome = await attemptFetch(url, {
                ...options,
                timeoutMs,
                deadline,
            });

            if (outcome.success) {
                return outcome.response;
            }

            const isLastAttempt = attempt === maxRetries;

            // Non-retryable failure or final attempt → propagate the error.
            if (!outcome.retryable || isLastAttempt) {
                throw outcome.error;
            }

            const delay = calculateBackoff(
                attempt,
                outcome.error instanceof TrialFetchError
                    ? outcome.error.retryAfterMs
                    : null,
            );

            const proxyUrl =
                outcome.error instanceof TrialFetchError ||
                outcome.error instanceof TrialTimeoutError
                    ? outcome.error.proxyUrl
                    : 'n/a';

            logger.warn(
                '%s - retrying in %dms (attempt %d/%d) | Proxy: %s | URL: %s',
                outcome.reason,
                Math.round(delay),
                attempt + 1,
                maxRetries,
                proxyUrl,
                url,
            );

            // Recalculate again because the fetch itself consumed time.
            const remainingBeforeSleep = getRemainingTime(
                deadline,
                url,
                timeoutMs,
            );

            if (delay >= remainingBeforeSleep) {
                throw new TrialTimeoutError(url, 0, {
                    totalBudgetMs: timeoutMs,
                });
            }

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
    async function fetchJson(url, {allow404 = false, ...requestOptions} = {}) {
        const response = await fetchWithRetry(url, requestOptions);
        return parseJsonResponse(
            response,
            url,
            {
                allow404,
                errorBodyPreviewLength: ERROR_BODY_PREVIEW_LENGTH,
                retryableStatusCodes: RETRYABLE_STATUS_CODES,
            });
    }

    /**
     * Closes the underlying EndpointManager, releasing all connection pools.
     * Call this on process shutdown (SIGTERM/SIGINT).
     *
     * @returns {Promise<void>}
     */
    function close() {
        return endpointManager.close();
    }

    return {fetchJson, close};
}

function transformFetchError(error,
                             {
                                 url,
                                 proxyUrl,
                                 remainingMs,
                                 timeoutMs,
                                 signal,
                             }) {
    const isTimeout = error?.name === 'TimeoutError';
    const isAbort =
        error?.name === 'AbortError' ||
        error?.code === 'ABORT_ERR';

    const isExternalAbort =
        isAbort &&
        signal?.aborted;

    if (isTimeout) {
        const timeoutErr = new TrialTimeoutError(
            url,
            remainingMs,
            {totalBudgetMs: timeoutMs},
        );

        timeoutErr.proxyUrl = proxyUrl;
        return timeoutErr;
    }

    if (isExternalAbort) {
        return error;
    }

    const fetchErr = new TrialFetchError(url, error, null, true,);

    fetchErr.proxyUrl = proxyUrl;
    return fetchErr;
}

function getRemainingTime(deadline, url, timeoutMs) {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
        throw new TrialTimeoutError(url, 0, {
            totalBudgetMs: timeoutMs,
        });
    }

    return remainingMs;
}