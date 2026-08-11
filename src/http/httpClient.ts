import { EndpointFactory } from './endpoint/endpointFactory.js';
import { EndpointManagerFactory } from './endpoint/manager/endpointManagerFactory.js';
import { EndpointProvider } from './endpoint/provider/endpointProvider.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';
import { FetchOperation } from './retry/fetchOperation.js';
import { DefaultLimiterFactory } from './limiter/factory/defaultLimiterFactory.js';
import { LimiterFactory } from './limiter/factory/limiterFactory.js';
import { parseOkResponseBody } from './responseBody.js';
import { HttpException } from './retry/exceptions.js';
import { Retry } from './retry/retry.js';
import { calculateBackoff, defaultRetryPolicyConfig, RetryPolicyConfig, shouldRetry } from './retry/retryPolicy.js';
import { FetchJsonRequestOptions, HttpClientOptions } from './types/http.js';
import { MAX_RETRIES } from '../config/config.js';

export interface HttpClient {
    /**
     * Performs an HTTP request and parses the response body as JSON.
     *
     * Returns null for 204 No Content responses, or for 404 responses
     * when allow404 is enabled.
     */
    fetchJson<T = unknown>(url: string, options?: FetchJsonRequestOptions): Promise<T | null>;

    /** Releases all underlying connection-pool resources. */
    close(): Promise<void>;
}

export function createHttpClient(
    clientOptions: HttpClientOptions,
    provider: EndpointProvider,
    limiterFactory: LimiterFactory = new DefaultLimiterFactory(),
    retryConfig: RetryPolicyConfig = defaultRetryPolicyConfig,
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
            // Body was already drained inside FetchOperation before the HttpException was thrown.
            if (options.allow404 && error instanceof HttpException && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async function fetchJson<T = unknown>(url: string, options: FetchJsonRequestOptions = {}): Promise<T | null> {
        const response = await fetchResponse(url, options);

        // fetchResponse returns null for allow404 + 404, and for 204 in fetchResponse
        // All other non-ok responses have already been thrown as HttpException
        if (response === null) return null;

        return parseOkResponseBody(response, url) as T;
    }

    async function close(): Promise<void> {
        await endpointManager.close();
    }

    return { fetchJson, close };

    function buildRetry(operation: FetchOperation, options: FetchJsonRequestOptions): Retry<HttpResponse> {
        const method = options.method ?? 'GET';

        // Per-call override (optional but handy)
        const effectiveConfig: RetryPolicyConfig = {
            retryOnTimeout: options.retryPolicy?.retryOnTimeout ?? retryConfig.retryOnTimeout,
            retryOnNetworkError: options.retryPolicy?.retryOnNetworkError ?? retryConfig.retryOnNetworkError,
            retryableStatusCodes: options.retryPolicy?.retryableStatusCodes ?? retryConfig.retryableStatusCodes,
        };

        return new Retry<HttpResponse>(
            operation,
            options.maxRetries ?? MAX_RETRIES,
            (attempt, error) => {
                const retryAfterMs = error instanceof HttpException ? (error.retryAfterMs ?? null) : null;
                return calculateBackoff(attempt, retryAfterMs);
            },
            (error) => shouldRetry(error, method, effectiveConfig, options.idempotent),
        );
    }
}
