import { randomUUID } from 'node:crypto';
import { BACKOFF_CAP_MS, FETCH_TIMEOUT_MS, MAX_RETRIES, RETRY_BASE_DELAY_MS } from '../config/config.js';
import { getLogContext, LogContext, withLogContext } from '../config/logContext.js';
import { createLogger } from '../config/logging.js';
import { CallerAbortedError, EndpointAssemblyError, HttpException, TrialError } from '../error/errors.js';
import { Retry } from '../retry/retry.js';
import {
    calculateBackoff,
    defaultRetryPolicyConfig,
    RetryPolicyConfig,
    shouldRetry,
    validateRetryPolicyConfig,
} from '../retry/retryPolicy.js';
import {
    defaultMonotonicClock,
    defaultRandom,
    defaultSleeper,
    defaultWallClock,
    MonotonicClock,
    RandomSource,
    Sleeper,
    WallClock,
} from './clock.js';
import { EndpointFactory } from './endpoint/endpointFactory.js';
import { EndpointManager } from './endpoint/manager/endpointManager.js';
import { EndpointManagerFactory } from './endpoint/manager/endpointManagerFactory.js';
import { EndpointProvider } from './endpoint/provider/endpointProvider.js';
import { FetchOperation } from './fetchOperation.js';
import { HTTP_METHOD_GET, type FetchJsonRequestOptions } from './http.js';
import { LimiterFactory } from './limiter/factory/limiterFactory.js';
import { validateFetchJsonRequestOptions } from './requestValidation.js';
import { parseOkResponseBody } from './responseBody.js';
import { HttpResponse } from './transport/httpTransport.js';

const logger = createLogger(import.meta.url);

type HttpErrorLogContext = {
    errorType: string;
    url: string;
    method: typeof HTTP_METHOD_GET;
    err: Error;
};

function createHttpErrorLogContext(error: Error, url: string): HttpErrorLogContext {
    return {
        err: error,
        errorType: error.name,
        url: sanitizeHttpUrl(url),
        method: HTTP_METHOD_GET,
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
    /** Override real sleep (e.g. fake timers in tests). Defaults to setTimeout. */
    sleep?: Sleeper['sleep'];

    /** Override Math.random (e.g. deterministic backoff in tests). */
    random?: RandomSource['random'];

    /** Wall-clock source used for HTTP-date calculations such as Retry-After. */
    wallClock?: WallClock;

    /** Supplies the endpoints the client will route requests through. */
    provider: EndpointProvider;

    /** Builds the rate limiter applied per endpoint. */
    limiterFactory: LimiterFactory;

    /** Creates the endpoint manager that owns endpoint pools. */
    endpointManagerFactory: EndpointManagerFactory;

    /** Retry policy. Defaults to the module-level default policy. */
    retryConfig?: RetryPolicyConfig;

    /** Monotonic source used for elapsed-duration measurements. */
    monotonicClock?: MonotonicClock;
}

export async function createHttpClient(options: CreateHttpClientOptions): Promise<HttpClient> {
    const {
        provider,
        limiterFactory,
        endpointManagerFactory,
        retryConfig = defaultRetryPolicyConfig,
        sleep = defaultSleeper.sleep,
        random = defaultRandom.random,
        wallClock = defaultWallClock,
        monotonicClock = defaultMonotonicClock,
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
        const operation = new FetchOperation(endpointManager, url, options, wallClock.now);
        const retry = buildRetry(operation, options, sleep, random, monotonicClock.now);

        logger.debug(
            {
                url: sanitizeHttpUrl(url),
                method: HTTP_METHOD_GET,
                allow404: options.allow404 ?? false,
                timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
                maxRetries: options.maxRetries ?? MAX_RETRIES,
            },
            'HTTP request started',
        );

        const requestStartedAt = monotonicClock.now();

        try {
            const response = await retry.perform();

            logger.debug(
                {
                    url: sanitizeHttpUrl(url),
                    method: HTTP_METHOD_GET,
                    status: response.status,
                    durationMs: monotonicClock.now() - requestStartedAt,
                },
                'HTTP request completed',
            );

            return response;
        } catch (error: unknown) {
            const trialError = TrialError.normalize(error);

            if (trialError instanceof CallerAbortedError) {
                if (
                    trialError.message === 'The operation was aborted.' ||
                    !trialError.message.includes(sanitizeHttpUrl(url))
                ) {
                    throw new CallerAbortedError(`Request cancelled by caller: ${sanitizeHttpUrl(url)}`, {
                        cause: trialError,
                    });
                }
                throw trialError;
            }

            if (options.allow404 && trialError instanceof HttpException && trialError.status === 404) {
                return null;
            }

            throw trialError;
        }
    }

    async function fetchJson<T = unknown>(url: string, options: FetchJsonRequestOptions = {}): Promise<T | null> {
        validateFetchJsonRequestOptions(options);

        // One requestId per HTTP request, shared by every retry attempt and all
        // request-scoped log records. It is an infrastructure concern and is
        // therefore never part of the public FetchJsonRequestOptions API.
        const requestId = randomUUID();
        const parentContext = getLogContext();

        const requestContext: LogContext =
            parentContext === undefined
                ? {
                      correlationId: randomUUID(),
                      requestId,
                      operation: 'http.fetchJson',
                  }
                : {
                      ...parentContext,
                      requestId,
                      operation: 'http.fetchJson',
                  };

        return withLogContext(requestContext, async () => {
            if (parentContext === undefined) {
                // Standalone/library use: there is no application boundary context,
                // so a fresh correlationId was created for this single request.
                // In application use (src/index.ts) the correlationId always comes
                // from the active context and is never regenerated here.
                logger.debug('No active logging context; generated standalone request context');
            }

            const response = await fetchResponse(url, options);

            // fetchResponse returns null ONLY for allow404 + 404.
            // 204 No Content is handled inside parseOkResponseBody, not here.
            if (response === null) {
                return null;
            }

            try {
                return (await parseOkResponseBody(response, url)) as T;
            } catch (error) {
                const trialError = TrialError.normalize(error);

                // The application-level boundary (e.g. fetchTrialSafe) reports
                // response-parsing failures; this layer only adds a low-level
                // diagnostic while preserving the original exception.
                logger.debug({ ...createHttpErrorLogContext(trialError, url) }, 'Failed to parse HTTP response body');

                throw trialError;
            }
        });
    }

    async function close(): Promise<void> {
        logger.info('Closing HTTP client');

        try {
            await endpointManager.close();
        } catch (error: unknown) {
            // The EndpointManager and the application boundary report close
            // failures; this layer only normalizes and preserves the exception.
            throw TrialError.normalize(error);
        }

        logger.info('HTTP client closed');
    }

    return { fetchJson, close };

    function buildRetry(
        operation: FetchOperation,
        options: FetchJsonRequestOptions,
        sleep: Sleeper['sleep'],
        random: () => number,
        monotonicNow: MonotonicClock['now'],
    ): Retry<HttpResponse> {
        const effectiveConfig = {
            retryOnTimeout: options.retryPolicy?.retryOnTimeout ?? retryConfig.retryOnTimeout,
            retryOnNetworkError: options.retryPolicy?.retryOnNetworkError ?? retryConfig.retryOnNetworkError,
            retryableStatusCodes: options.retryPolicy?.retryableStatusCodes ?? retryConfig.retryableStatusCodes,
            baseDelayMs: options.retryPolicy?.baseDelayMs ?? retryConfig.baseDelayMs ?? RETRY_BASE_DELAY_MS,
            backoffCapMs: options.retryPolicy?.backoffCapMs ?? retryConfig.backoffCapMs ?? BACKOFF_CAP_MS,
        };

        validateRetryPolicyConfig(effectiveConfig);

        const maxRetries = options.maxRetries ?? MAX_RETRIES;
        const maxAttempts = maxRetries + 1;

        return new Retry<HttpResponse>(
            operation,
            maxAttempts,
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
            monotonicNow,
        );
    }
}

function sanitizeHttpUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return '<invalid URL>';
    }
}
