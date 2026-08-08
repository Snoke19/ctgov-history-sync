import { MAX_RETRIES, RETRYABLE_STATUS_CODES, RETRY_ON_NETWORK_ERROR, RETRY_ON_TIMEOUT } from '../config/config.js';
import { EndpointFactory } from './endpoint/endpointFactory.js';
import { EndpointManagerFactory } from './endpoint/manager/endpointManagerFactory.js';
import { EndpointProvider } from './endpoint/provider/endpointProvider.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';
import { FetchOperation } from './fetchOperation.js';
import { DefaultLimiterFactory } from './limiter/factory/defaultLimiterFactory.js';
import { LimiterFactory } from './limiter/factory/limiterFactory.js';
import { parseOkResponseBody } from './responseBody.js';
import { BusinessException } from './retry/businessException.js';
import { HttpException, NetworkException, TimeoutException } from './retry/exceptions.js';
import { Retry } from './retry/retry.js';
import { calculateBackoff, isIdempotent } from './retry/retryPolicy.js';
import { FetchJsonRequestOptions, HttpClientOptions } from './types/http.js';

export interface HttpClient {
    /**
     * Performs an HTTP request and parses the response body as JSON.
     *
     * Returns null for 204 No Content responses, or for 404 responses
     * when allow404 is enabled.
     */
    fetchJson<T = unknown>(url: string, options?: FetchJsonRequestOptions): Promise<T>;

    /** Releases all underlying connection-pool resources. */
    close(): Promise<void>;
}

export function createHttpClient(
    clientOptions: HttpClientOptions,
    provider: EndpointProvider,
    limiterFactory: LimiterFactory = new DefaultLimiterFactory(),
): HttpClient {
    const endpointFactory = new EndpointFactory(provider, limiterFactory);
    const endpointManager = new EndpointManagerFactory(endpointFactory).create(clientOptions);

    async function fetchResponse(url: string, options: FetchJsonRequestOptions): Promise<HttpResponse | null> {
        const operation = new FetchOperation(endpointManager, url, options);
        const retry = buildRetry(operation, options);

        try {
            return await retry.perform();
        } catch (error) {
            // A 404 is never retried (shouldRetry returns false for it), so when
            // it arrives here it is the final, definitive response from the server.
            if (options.allow404 && error instanceof HttpException && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async function fetchJson<T = unknown>(url: string, options: FetchJsonRequestOptions = {}): Promise<T> {
        const response = await fetchResponse(url, options);

        // fetchResponse returns null for allow404 + 404, and for 204 in fetchResponse
        // All other non-ok responses have already been thrown as HttpException
        if (response === null) return null as T;

        return parseOkResponseBody(response, url) as T;
    }

    async function close(): Promise<void> {
        await endpointManager.close();
    }

    return { fetchJson, close };
}

function buildRetry(operation: FetchOperation, options: FetchJsonRequestOptions): Retry<HttpResponse> {
    const method = options.method ?? 'GET';

    return new Retry<HttpResponse>(
        operation,
        options.maxRetries ?? MAX_RETRIES,
        (attempt, error) => {
            const retryAfterMs = error instanceof HttpException ? (error.retryAfterMs ?? null) : null;
            return calculateBackoff(attempt, retryAfterMs);
        },
        (error) => shouldRetry(error, method, options.idempotent),
    );
}

/**
 * Decides whether a given error warrants another attempt.
 *
 * - Timeouts        → retried only when RETRY_ON_TIMEOUT is enabled in config.
 * - Network errors  → retried only when RETRY_ON_NETWORK_ERROR is enabled.
 * - HTTP errors     → retried only if the status is in RETRYABLE_STATUS_CODES;
 *                     5xx additionally requires the request to be idempotent,
 *                     since the server may have already applied the mutation.
 */
function shouldRetry(error: BusinessException, method: string, idempotent?: boolean): boolean {
    if (error instanceof TimeoutException) return RETRY_ON_TIMEOUT;
    if (error instanceof NetworkException) return RETRY_ON_NETWORK_ERROR;

    if (error instanceof HttpException) {
        if (!RETRYABLE_STATUS_CODES.has(error.status)) return false;
        if (error.status >= 500) return isIdempotent(method, idempotent);
        return true;
    }

    return false;
}
