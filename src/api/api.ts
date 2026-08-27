import { AppConfig, loadConfig } from '../config/appConfig.js';
import { defaults } from '../config/defaults.js';
import { createLogger } from '../config/logging.js';
import { ApiResponseValidationError, TrialError, TrialNotFoundError, TrialValidationError } from '../error/errors.js';
import { sanitizeHttpUrl } from '../error/normalization/urlSanitizer.js';
import { ProxyEndpointProvider } from '../http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../http/endpoint/proxy/httpProxyUrlParser.js';
import { createHttpClient, HttpClientDefaults } from '../http/httpClient.js';
import { DefaultLimiterFactory } from '../http/limiter/factory/defaultLimiterFactory.js';
import { UndiciTransportFactory } from '../http/transport/impl/undiciProxyTransport.js';
import { UrlBuilder } from '../http/urlPrepare.js';
import { FetchOperationDefaults } from '../retry/fetchOperation.js';
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
    retryOnTimeout: defaults.RETRY_ON_TIMEOUT,
    retryOnNetworkError: defaults.RETRY_ON_NETWORK_ERROR,
    retryableStatusCodes: new Set(defaults.RETRYABLE_STATUS_CODES),
    baseDelayMs: defaults.RETRY_BASE_DELAY_MS,
    backoffCapMs: defaults.BACKOFF_CAP_MS,
};

export const defaultHttpClientDefaults: HttpClientDefaults = {
    requestAbortTimeoutMs: defaults.REQUEST_ABORT_TIMEOUT_MS,
    maxRetries: defaults.MAX_RETRIES,
    retryPolicy: defaultRetryPolicyConfig,
};

export const defaultFetchOperationDefaults: FetchOperationDefaults = {
    requestAbortTimeoutMs: defaults.REQUEST_ABORT_TIMEOUT_MS,
    userAgent: defaults.DEFAULT_USER_AGENT,
};

/**
 * Creates a production-ready API client with the application's configured
 * HTTP infrastructure.
 *
 * Explicit dependency: environment → loadConfig() → AppConfig → composition root.
 * Pass AppConfig from the application boundary (src/index.ts). When omitted,
 * loadConfig() is called lazily for backwards compatibility with tests.
 */
export async function createApiClient(appConfig?: AppConfig): Promise<ApiClient> {
    const config = appConfig ?? loadConfig();

    logger.info(
        {
            nodeEnv: config.logging.nodeEnv || null,
            apiBaseUrl: sanitizeHttpUrl(config.api.baseUrl),
            apiDetailUrl: sanitizeHttpUrl(config.api.detailUrl),
            concurrency: config.http.concurrency,
            rateLimitCapacity: config.rateLimit.capacity,
            rateLimitWindowMs: config.rateLimit.windowMs,
            endpointAcquireTimeoutMs: config.endpoint.acquireTimeoutMs,
        },
        'API configuration loaded',
    );

    const retryPolicy: RetryPolicyConfig = {
        retryOnTimeout: config.http.retryOnTimeout,
        retryOnNetworkError: config.http.retryOnNetworkError,
        retryableStatusCodes: config.http.retryableStatusCodes,
        baseDelayMs: config.http.retryBaseDelayMs,
        backoffCapMs: config.http.backoffCapMs,
    };

    const httpDefaults: HttpClientDefaults = {
        requestAbortTimeoutMs: config.http.requestAbortTimeoutMs,
        maxRetries: config.http.maxRetries,
        retryPolicy,
    };

    const fetchDefaults: FetchOperationDefaults = {
        requestAbortTimeoutMs: config.http.requestAbortTimeoutMs,
        userAgent: config.http.defaultUserAgent,
    };

    let httpClient: ApiHttpClient | undefined;

    try {
        httpClient = await createHttpClient({
            defaults: httpDefaults,
            fetchDefaults,
            provider: new ProxyEndpointProvider(
                new UndiciTransportFactory({ poolConfig: config.proxy.pool }),
                new HttpProxyUrlParser(),
                {
                    proxyUrls: config.proxy.urls,
                    concurrency: config.http.concurrency,
                },
            ),
            limiterFactory: new DefaultLimiterFactory({
                enabled: true,
                capacity: config.rateLimit.capacity,
                windowMs: config.rateLimit.windowMs,
            }),
            endpointManagerOptions: {
                endpointAcquireTimeoutMs: config.endpoint.acquireTimeoutMs,
            },
        });

        const apiClient = createApiClientWithHttpClient(httpClient, config);

        logger.info(
            { apiBaseUrl: sanitizeHttpUrl(config.api.baseUrl), apiDetailUrl: sanitizeHttpUrl(config.api.detailUrl) },
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
 * DI seam for tests. When appConfig is omitted, URLs are resolved lazily
 * from loadConfig() so existing tests continue to work without changes.
 */
export function createApiClientWithHttpClient(
    httpClient: ApiHttpClient,
    appConfig?: Pick<AppConfig, 'api'>,
): ApiClient {
    const apiConfig = appConfig ?? loadConfig();

    async function fetchStudiesPage(params: FetchStudiesPageParams = {}): Promise<StudiesPageResponse> {
        const url = new UrlBuilder(apiConfig.api.baseUrl).queryParams(params).build();

        logger.debug(
            {
                operation: 'fetchStudiesPage',
                url: sanitizeHttpUrl(url),
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

        const url = new UrlBuilder(apiConfig.api.detailUrl).path(normalizedNctId).queryParams(params).build();

        logger.debug(
            { operation: 'fetchTrialDetail', nctId: normalizedNctId, url: sanitizeHttpUrl(url) },
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
