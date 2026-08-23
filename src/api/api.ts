import {
    API_BASE_URL,
    API_DETAIL_URL,
    ACQUIRE_TIMEOUT,
    CONCURRENCY,
    PROXY_POOL_CONFIG,
    PROXY_URLS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
    RETRY_ON_TIMEOUT,
    RETRY_ON_NETWORK_ERROR,
    RETRYABLE_STATUS_CODES,
    RETRY_BASE_DELAY_MS,
    BACKOFF_CAP_MS,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    DEFAULT_USER_AGENT,
} from '../config/config.js';
import { createLogger } from '../config/logging.js';
import { ApiResponseValidationError, TrialError, TrialNotFoundError, TrialValidationError } from '../error/errors.js';
import { DefaultEndpointManagerFactory } from '../http/endpoint/manager/defaultEndpointManagerFactory.js';
import { ProxyEndpointProvider } from '../http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../http/endpoint/proxy/httpProxyUrlParser.js';
import { FetchOperationDefaults } from '../http/fetchOperation.js';
import { createHttpClient, HttpClientDefaults } from '../http/httpClient.js';
import { DefaultLimiterFactory } from '../http/limiter/factory/defaultLimiterFactory.js';
import { UndiciTransportFactory } from '../http/transport/impl/undiciProxyTransport.js';
import { UrlBuilder } from '../http/urlPrepare.js';
import { RetryPolicyConfig } from '../retry/retryPolicy.js';
import { Assertions, makeAssertions } from '../utils/assertions.js';
import { FetchStudiesPageParams, FetchTrialDetailParams, StudiesPageResponse, Study } from './types.js';

const logger = createLogger(import.meta.url);
const NCT_ID_PATTERN = /^NCT\d{8}$/;
const trialAssert: Assertions = makeAssertions(TrialValidationError);

export interface ApiHttpClient {
    fetchJson(url: string, options?: { allow404?: boolean }): Promise<unknown | null>;
    close(): Promise<void>;
}

export interface ApiClient {
    fetchStudiesPage(params?: FetchStudiesPageParams): Promise<StudiesPageResponse>;

    fetchTrialDetail(nctId: string, params?: FetchTrialDetailParams): Promise<unknown>;

    close(): Promise<void>;
}

export const defaultRetryPolicyConfig: RetryPolicyConfig = {
    retryOnTimeout: RETRY_ON_TIMEOUT,
    retryOnNetworkError: RETRY_ON_NETWORK_ERROR,
    retryableStatusCodes: RETRYABLE_STATUS_CODES,
    baseDelayMs: RETRY_BASE_DELAY_MS,
    backoffCapMs: BACKOFF_CAP_MS,
};

export const defaultHttpClientDefaults: HttpClientDefaults = {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    retryPolicy: defaultRetryPolicyConfig,
};

export const defaultFetchOperationDefaults: FetchOperationDefaults = {
    timeoutMs: FETCH_TIMEOUT_MS,
    userAgent: DEFAULT_USER_AGENT,
};

/**
 * Creates a production-ready API client with the application's configured
 * HTTP infrastructure.
 *
 * The HTTP client, proxy endpoint provider, transport factory, rate limiter,
 * and connection-pool configuration are intentionally hidden from callers.
 *
 * Logging context (correlationId, operation) is picked up automatically from
 * the AsyncLocalStorage context of the caller.
 */
export async function createApiClient(): Promise<ApiClient> {
    logger.info(
        {
            nodeEnv: process.env.NODE_ENV ?? null,
            apiBaseUrl: safeApiUrl(API_BASE_URL),
            apiDetailUrl: safeApiUrl(API_DETAIL_URL),
            concurrency: CONCURRENCY,
            rateLimitCapacity: RATE_LIMIT_CAPACITY,
            rateLimitWindowMs: RATE_LIMIT_WINDOW,
            acquireTimeoutMs: ACQUIRE_TIMEOUT,
        },
        'API configuration loaded',
    );

    let httpClient: ApiHttpClient | undefined;

    try {
        httpClient = await createHttpClient({
            defaults: defaultHttpClientDefaults,
            fetchDefaults: defaultFetchOperationDefaults,
            provider: new ProxyEndpointProvider(
                new UndiciTransportFactory({ poolConfig: PROXY_POOL_CONFIG }),
                new HttpProxyUrlParser(),
                {
                    proxyUrls: PROXY_URLS,
                    concurrency: CONCURRENCY,
                },
            ),
            limiterFactory: new DefaultLimiterFactory({
                enabled: true,
                capacity: RATE_LIMIT_CAPACITY,
                windowMs: RATE_LIMIT_WINDOW,
            }),
            endpointManagerFactory: new DefaultEndpointManagerFactory({
                acquireTimeout: ACQUIRE_TIMEOUT,
            }),
        });

        const apiClient = createApiClientWithHttpClient(httpClient);

        logger.info(
            { apiBaseUrl: safeApiUrl(API_BASE_URL), apiDetailUrl: safeApiUrl(API_DETAIL_URL) },
            'API client created',
        );

        return apiClient;
    } catch (error: unknown) {
        const trialError = TrialError.normalize(error);

        // The application boundary (src/index.ts) reports the final failure;
        // this layer preserves the original exception and releases resources.

        if (httpClient !== undefined) {
            try {
                await httpClient.close();
            } catch (cleanupError: unknown) {
                // A cleanup failure after an initialization failure has no
                // other reporting path, so it is logged here and swallowed.
                const cleanupTrialError = TrialError.normalize(cleanupError);
                logger.error(
                    { err: cleanupTrialError, operation: 'createApiClient.cleanup', errorType: cleanupTrialError.name },
                    'Failed to clean up HTTP client after initialization failure',
                );
            }
        }

        throw trialError;
    }
}

/**
 * Creates an API client from an already-created HTTP client.
 *
 * This is the dependency-injection seam used by unit tests and callers that
 * intentionally provide custom HTTP infrastructure.
 */
export function createApiClientWithHttpClient(httpClient: ApiHttpClient): ApiClient {
    async function fetchStudiesPage(params: FetchStudiesPageParams = {}): Promise<StudiesPageResponse> {
        const url = new UrlBuilder(API_BASE_URL).queryParams(params).build();

        logger.debug(
            {
                operation: 'fetchStudiesPage',
                url: safeApiUrl(url),
                pageSize: params.pageSize ?? null,
                hasPageToken: Boolean(params.pageToken),
            },
            'Fetching studies page',
        );

        const data = await httpClient.fetchJson(url);

        const page = parseStudiesPageResponse(data, url);

        return page;
    }

    async function fetchTrialDetail(nctId: string, params: FetchTrialDetailParams = {}): Promise<unknown> {
        const normalizedNctId = validateNctId(nctId);

        const url = new UrlBuilder(API_DETAIL_URL).path(normalizedNctId).queryParams(params).build();

        logger.debug(
            { operation: 'fetchTrialDetail', nctId: normalizedNctId, url: safeApiUrl(url) },
            'Fetching trial detail',
        );

        const data = await httpClient.fetchJson(url, { allow404: true });

        if (data === null) {
            logger.debug({ operation: 'fetchTrialDetail', nctId: normalizedNctId }, 'Trial not found (404)');

            throw new TrialNotFoundError(normalizedNctId);
        }

        return data;
    }

    async function close(): Promise<void> {
        logger.debug('API client closing');

        await httpClient.close();

        logger.debug('API client closed');
    }

    return {
        fetchStudiesPage,
        fetchTrialDetail,
        close,
    };
}

function parseStudiesPageResponse(value: unknown, url: string): StudiesPageResponse {
    if (!isStudiesPageResponse(value)) {
        throw new ApiResponseValidationError(url, 'Expected a valid studies page response.');
    }

    return value;
}

function isStudiesPageResponse(value: unknown): value is StudiesPageResponse {
    if (!isRecord(value)) {
        return false;
    }

    if (!Array.isArray(value.studies)) {
        return false;
    }

    if (value.nextPageToken !== undefined && typeof value.nextPageToken !== 'string') {
        return false;
    }

    return value.studies.every(isStudy);
}

function isStudy(value: unknown): value is Study {
    if (!isRecord(value)) {
        return false;
    }

    const { protocolSection } = value;

    if (protocolSection === undefined) {
        return true;
    }

    if (!isRecord(protocolSection)) {
        return false;
    }

    const { identificationModule } = protocolSection;

    if (identificationModule === undefined) {
        return true;
    }

    if (!isRecord(identificationModule)) {
        return false;
    }

    const { nctId } = identificationModule;

    return nctId === undefined || typeof nctId === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function safeApiUrl(value: string): string {
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return '<invalid URL>';
    }
}

function validateNctId(value: string): string {
    trialAssert.assertNonEmptyString(value, 'nctId');

    const normalized = value.trim().toUpperCase();

    trialAssert.assertPattern(
        normalized,
        NCT_ID_PATTERN,
        `Invalid nctId format. Expected: NCT followed by 8 digits. Got: "${value}"`,
    );

    return normalized;
}
