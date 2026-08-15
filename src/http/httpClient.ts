import { Logger } from 'pino';
import { BACKOFF_CAP_MS, FETCH_TIMEOUT_MS, MAX_RETRIES, RETRY_BASE_DELAY_MS } from '../config/config.js';
import {
    CallerAbortedError,
    EndpointAssemblyError,
    HttpException,
    NetworkException,
    TrialError,
} from '../error/errors.js';
import { Retry } from '../retry/retry.js';
import { defaultRandom, defaultSleeper, defaultWallClock, Sleeper } from './clock.js';
import { EndpointFactory } from './endpoint/endpointFactory.js';
import { EndpointManager } from './endpoint/manager/endpointManager.js';
import { EndpointManagerFactory } from './endpoint/manager/endpointManagerFactory.js';
import { EndpointProvider } from './endpoint/provider/endpointProvider.js';
import { FetchOperation } from './fetchOperation.js';
import type { FetchJsonRequestOptions, HttpClientOptions } from './http.js';
import { LimiterFactory } from './limiter/factory/limiterFactory.js';
import { validateFetchJsonRequestOptions } from './requestValidation.js';
import { parseOkResponseBody } from './responseBody.js';
import {
    calculateBackoff,
    defaultRetryPolicyConfig,
    RetryPolicyConfig,
    shouldRetry,
    validateRetryPolicyConfig,
} from './retryPolicy.js';
import { HttpResponse } from './transport/httpTransport.js';

type HttpErrorLogContext = {
    message: string;
    errorType: string;
    url: string;
    method: 'GET';
    err: Error;
};

function createHttpErrorLogContext(error: Error, url: string): HttpErrorLogContext {
    return {
        message: error.message,
        err: error,
        errorType: error.name,
        url,
        method: 'GET',
    };
}

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

export interface CreateHttpClientOptions {
    /** Client-level behavior overrides (clocks, jitter source). */
    clientOptions: HttpClientOptions;

    /** Supplies the endpoints the client will route requests through. */
    provider: EndpointProvider;

    /** Builds the rate limiter applied per endpoint. */
    limiterFactory: LimiterFactory;

    /** Logger used for HTTP-layer tracing. */
    logger: Logger;

    /** Creates the endpoint manager that owns endpoint pools. */
    endpointManagerFactory: EndpointManagerFactory;

    /** Retry policy. Defaults to the module-level default policy. */
    retryConfig?: RetryPolicyConfig;
}

export async function createHttpClient(options: CreateHttpClientOptions): Promise<HttpClient> {
    const {
        clientOptions,
        provider,
        limiterFactory,
        logger,
        endpointManagerFactory,
        retryConfig = defaultRetryPolicyConfig,
    } = options;

    // Fail-fast on invalid retry policy configuration.
    validateRetryPolicyConfig(retryConfig);

    const endpointFactory = new EndpointFactory(provider, limiterFactory);
    const endpoints = await endpointFactory.build();

    let endpointManager: EndpointManager;

    try {
        endpointManager = endpointManagerFactory.create(endpoints);
    } catch (error: unknown) {
        const trialError = TrialError.normalize(error);

        const cleanupResults = await Promise.allSettled(endpoints.map((endpoint) => endpoint.close()));
        const cleanupErrors = cleanupResults
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason);

        if (cleanupErrors.length > 0) {
            throw new EndpointAssemblyError(
                'Failed to create endpoint manager and endpoint cleanup also failed.',
                {
                    cause: trialError,
                },
                cleanupErrors,
            );
        }

        throw trialError;
    }

    logger.info(
        {
            endpointCount: endpoints.length,
        },
        'HTTP client created',
    );

    async function fetchResponse(url: string, options: FetchJsonRequestOptions): Promise<HttpResponse | null> {
        const operation = new FetchOperation(
            endpointManager,
            url,
            options,
            clientOptions.wallClock?.now ?? defaultWallClock.now,
        );
        const retry = buildRetry(
            operation,
            options,
            clientOptions.sleep ?? defaultSleeper.sleep,
            clientOptions.random ?? defaultRandom.random,
        );

        logger.debug(
            {
                url,
                method: 'GET',
                allow404: options.allow404 ?? false,
                timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
                maxRetries: options.maxRetries ?? MAX_RETRIES,
            },
            'HTTP request started',
        );

        const requestStartedAt = Date.now();

        try {
            const response = await retry.perform();

            logger.debug(
                {
                    url,
                    method: 'GET',
                    status: response.status,
                    durationMs: Date.now() - requestStartedAt,
                },
                'HTTP request completed',
            );

            return response;
        } catch (error: unknown) {
            const trialError = TrialError.normalize(error);

            // CallerAbortedError is an internal control-flow error. The public HTTP
            // client exposes caller cancellation as NetworkException while retaining
            // the original cancellation error as `cause`.
            if (trialError instanceof CallerAbortedError && options.signal?.aborted) {
                throw new NetworkException(`Request cancelled by caller: ${url}`, {
                    cause: trialError,
                });
            }

            if (options.allow404 && trialError instanceof HttpException && trialError.status === 404) {
                return null;
            }

            logger.error(createHttpErrorLogContext(trialError, url), 'HTTP request failed');

            throw trialError;
        }
    }

    async function fetchJson<T = unknown>(url: string, options: FetchJsonRequestOptions = {}): Promise<T | null> {
        validateFetchJsonRequestOptions(options);

        const response = await fetchResponse(url, options);

        // fetchResponse returns null ONLY for allow404 + 404.
        // 204 No Content is handled inside parseOkResponseBody, not here.
        if (response === null) {
            return null;
        }

        const parseStartedAt = Date.now();

        try {
            const parsed = parseOkResponseBody(response, url) as T;

            logger.debug({ url, durationMs: Date.now() - parseStartedAt }, 'HTTP response body parsed');

            return parsed;
        } catch (error) {
            const trialError = TrialError.normalize(error);

            logger.error(createHttpErrorLogContext(trialError, url), 'Failed to parse HTTP response body');

            throw trialError;
        }
    }

    async function close(): Promise<void> {
        await endpointManager.close();
    }

    return { fetchJson, close };

    function buildRetry(
        operation: FetchOperation,
        options: FetchJsonRequestOptions,
        sleep: Sleeper['sleep'],
        random: () => number,
    ): Retry<HttpResponse> {
        const effectiveConfig = {
            retryOnTimeout: options.retryPolicy?.retryOnTimeout ?? retryConfig.retryOnTimeout,
            retryOnNetworkError: options.retryPolicy?.retryOnNetworkError ?? retryConfig.retryOnNetworkError,
            retryableStatusCodes: options.retryPolicy?.retryableStatusCodes ?? retryConfig.retryableStatusCodes,
            baseDelayMs: options.retryPolicy?.baseDelayMs ?? retryConfig.baseDelayMs ?? RETRY_BASE_DELAY_MS,
            backoffCapMs: options.retryPolicy?.backoffCapMs ?? retryConfig.backoffCapMs ?? BACKOFF_CAP_MS,
        };

        validateRetryPolicyConfig(effectiveConfig);

        return new Retry<HttpResponse>(
            operation,
            options.maxRetries ?? MAX_RETRIES,
            (error) => shouldRetry(error, effectiveConfig),
            (attempt, error) => {
                const retryAfterMs = error instanceof HttpException ? (error.retryAfterMs ?? null) : null;

                return calculateBackoff(attempt, retryAfterMs, {
                    random,
                    baseDelayMs: effectiveConfig.baseDelayMs,
                    backoffCapMs: effectiveConfig.backoffCapMs,
                });
            },
            sleep,
            options.signal,
        );
    }
}
