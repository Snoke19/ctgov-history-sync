import { MAX_RETRIES } from '../config/config.js';
import { CallerAbortedError, HttpException, NetworkException } from '../error/errors.js';
import { EndpointFactory } from './endpoint/endpointFactory.js';
import { EndpointManagerFactory } from './endpoint/manager/endpointManagerFactory.js';
import { EndpointProvider } from './endpoint/provider/endpointProvider.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';
import { DefaultLimiterFactory } from './limiter/factory/defaultLimiterFactory.js';
import { LimiterFactory } from './limiter/factory/limiterFactory.js';
import { parseOkResponseBody } from './responseBody.js';
import { FetchOperation } from './retry/fetchOperation.js';
import { Retry } from './retry/retry.js';
import { calculateBackoff, defaultRetryPolicyConfig, shouldRetry } from './retry/retryPolicy.js';
import type { RetryPolicyConfig } from './retry/retryPolicy.js';
import { defaultRandom, defaultSleeper } from './types/clock.js';
import type { FetchJsonRequestOptions, HttpClientOptions } from './types/http.js';

export interface HttpClient {
    /**
     * Performs an HTTP request and parses the response body as JSON.
     *
     * Returns null for:
     * - 204 No Content responses.
     * - 404 Not Found responses when allow404 is enabled.
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
        const operation = new FetchOperation(endpointManager, url, options, clientOptions.clock?.now);
        const retry = buildRetry(
            operation,
            options,
            clientOptions.sleep ?? defaultSleeper.sleep,
            clientOptions.random ?? defaultRandom.random,
        );

        try {
            return await retry.perform();
        } catch (error) {
            // A caller abort can surface from a retry backoff wait (the sleeper
            // wakes up early). Classify it the same way FetchOperation classifies
            // an abort of an in-flight request, so the public API always reports
            // caller cancellation as a NetworkException.
            if (error instanceof CallerAbortedError && options.signal?.aborted) {
                throw new NetworkException(`Request cancelled by caller: ${url}`, error);
            }
            // INVARIANT: 404 must NOT be present in retryConfig.retryableStatusCodes.
            // If it were, retry.perform() would loop instead of throwing, and this
            // catch block would never be reached, silently breaking allow404.
            if (options.allow404 && error instanceof HttpException && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async function fetchJson<T = unknown>(url: string, options: FetchJsonRequestOptions = {}): Promise<T | null> {
        const response = await fetchResponse(url, options);

        // fetchResponse returns null ONLY for allow404 + 404.
        // 204 No Content is handled inside parseOkResponseBody, not here.
        if (response === null) return null;

        return parseOkResponseBody(response, url) as T;
    }

    async function close(): Promise<void> {
        await endpointManager.close();
    }

    return { fetchJson, close };

    function buildRetry(
        operation: FetchOperation,
        options: FetchJsonRequestOptions,
        sleep: (ms: number) => Promise<void>,
        random: () => number,
    ): Retry<HttpResponse> {
        const method = options.method ?? 'GET';

        const effectiveConfig: RetryPolicyConfig = {
            retryOnTimeout: options.retryPolicy?.retryOnTimeout ?? retryConfig.retryOnTimeout,
            retryOnNetworkError: options.retryPolicy?.retryOnNetworkError ?? retryConfig.retryOnNetworkError,
            retryableStatusCodes: options.retryPolicy?.retryableStatusCodes ?? retryConfig.retryableStatusCodes,
        };

        if (effectiveConfig.retryableStatusCodes.has(404)) {
            throw new Error(
                'Invariant violated: 404 must not be in retryableStatusCodes. ' +
                    'The allow404 option depends on 404 being non-retryable so that ' +
                    'retry.perform() throws an HttpException instead of looping.',
            );
        }

        return new Retry<HttpResponse>(
            operation,
            options.maxRetries ?? MAX_RETRIES,
            (error) => shouldRetry(error, method, effectiveConfig, options.idempotent),
            (attempt, error) => {
                const retryAfterMs = error instanceof HttpException ? (error.retryAfterMs ?? null) : null;
                return calculateBackoff(attempt, retryAfterMs, random);
            },
            sleep,
            options.signal,
        );
    }
}
