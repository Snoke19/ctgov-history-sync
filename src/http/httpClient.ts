import { performance } from 'node:perf_hooks';
import {
    DEFAULT_USER_AGENT,
    ERROR_BODY_PREVIEW_LENGTH,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../config/config.js';
import { logger } from '../config/logging.js';
import { TrialFetchError, TrialTimeoutError } from '../error/errors.js';
import { EndpointManagerFactory } from './endpoint/endpointManagerFactory.js';
import { drainBody, parseJsonResponse } from './responseBody.js';
import {
    buildRetryableError,
    calculateBackoff,
    classifyError,
    isIdempotent,
} from './retry/retryPolicy.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { FetchJsonRequestOptions, HttpClientOptions } from './types/http.js';
import { ProxyEndpointFactory } from './endpoint/proxy/proxyEndpointFactory.js';
import { EndpointFactory } from './endpoint/endpointFactory.js';
import { UndiciTransportFactory } from './endpoint/transport/undiciProxyTransport.js';

const DEFAULT_HEADERS = Object.freeze({
    Accept: 'application/json',
    'User-Agent': DEFAULT_USER_AGENT,
});

export function createHttpClient(endpointManagerOptions: HttpClientOptions) {
    const proxyFactory = new ProxyEndpointFactory(new UndiciTransportFactory());
    const endpointFactory = new EndpointFactory(proxyFactory);
    const endpointManager = new EndpointManagerFactory(endpointFactory).create(
        endpointManagerOptions,
    );

    async function executeFetch(url: any, options: any = {}) {
        const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const deadline = options.deadline ?? Date.now() + timeoutMs;

        let proxyEntry;
        try {
            const remainingBeforeAcquire = getRemainingTime(deadline, url, timeoutMs);
            proxyEntry = await endpointManager.acquireEndpoint(remainingBeforeAcquire);
        } catch (error: any) {
            logger.warn('Endpoint acquisition failed | URL: %s | Error: %s', url, error.message);
            throw error;
        }

        const proxyUrl = proxyEntry.url;

        const remainingBeforeFetch = getRemainingTime(deadline, url, timeoutMs);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort(new DOMException('Request timed out', 'TimeoutError'));
        }, remainingBeforeFetch);

        const signal = options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal;

        const headers: Record<string, string> = options.headers
            ? {
                  ...DEFAULT_HEADERS,
                  ...options.headers,
              }
            : { ...DEFAULT_HEADERS };

        const startTime = performance.now();

        // Step 5: Execute request.
        try {
            const response = await proxyEntry.transport.request({
                url,
                method: options.method ?? 'GET',
                headers,
                body: options.body,
                signal,
            });
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

            const transformed = transformFetchError(error, {
                url,
                proxyUrl,
                remainingMs: remainingBeforeFetch,
                timeoutMs,
                signal: options.signal,
            });

            const logMessage = transformed.cause?.message ?? transformed.message;
            const failureType =
                transformed instanceof TrialTimeoutError
                    ? 'Timeout'
                    : transformed === error
                      ? 'Cancelled'
                      : 'Network Error';

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

    async function attemptFetch(url: any, options: any) {
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
        } catch (error: any) {
            const { isTimeout, isCancelled, reason } = classifyError(error);

            return {
                success: false,
                error,
                retryable:
                    !isCancelled &&
                    ((isTimeout && RETRY_ON_TIMEOUT) ||
                        (Boolean(error.isTransient) && RETRY_ON_NETWORK_ERROR)),
                reason,
            };
        }
    }

    async function fetchWithRetry(
        url: string,
        { method = 'GET', ...options }: FetchJsonRequestOptions,
    ) {
        const canRetry = isIdempotent(method, options.idempotent);
        const maxRetries = canRetry ? Math.max(0, options.maxRetries ?? MAX_RETRIES) : 0;

        const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const outcome: any = await attemptFetch(url, {
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
                outcome.error instanceof TrialFetchError ? outcome.error.retryAfterMs : null,
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
            const remainingBeforeSleep = getRemainingTime(deadline, url, timeoutMs);

            if (delay >= remainingBeforeSleep) {
                throw new TrialTimeoutError(url, 0, {
                    totalBudgetMs: timeoutMs,
                });
            }

            await sleep(delay);
        }
    }

    async function fetchJson(
        url: string,
        { allow404 = false, ...requestOptions }: FetchJsonRequestOptions,
    ) {
        const response = await fetchWithRetry(url, requestOptions);
        return parseJsonResponse(response, url, {
            allow404,
            errorBodyPreviewLength: ERROR_BODY_PREVIEW_LENGTH,
            retryableStatusCodes: RETRYABLE_STATUS_CODES,
        });
    }

    function close() {
        return endpointManager.close();
    }

    return { fetchJson, close };
}

function transformFetchError(error: any, { url, proxyUrl, remainingMs, timeoutMs, signal }: any) {
    const isTimeout = error?.name === 'TimeoutError';
    const isAbort = error?.name === 'AbortError' || error?.code === 'ABORT_ERR';

    const isExternalAbort = isAbort && signal?.aborted;

    if (isTimeout) {
        const timeoutErr = new TrialTimeoutError(url, remainingMs, { totalBudgetMs: timeoutMs });

        timeoutErr.proxyUrl = proxyUrl;
        return timeoutErr;
    }

    if (isExternalAbort) {
        return error;
    }

    const fetchErr = new TrialFetchError(url, error, null, true);

    fetchErr.proxyUrl = proxyUrl;
    return fetchErr;
}

function getRemainingTime(deadline: any, url: any, timeoutMs: any) {
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
        throw new TrialTimeoutError(url, 0, {
            totalBudgetMs: timeoutMs,
        });
    }

    return remainingMs;
}
