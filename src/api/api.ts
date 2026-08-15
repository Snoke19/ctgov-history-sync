import {
    API_BASE_URL,
    API_DETAIL_URL,
    ACQUIRE_TIMEOUT,
    CONCURRENCY,
    PROXY_POOL_CONFIG,
    PROXY_URLS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
} from '../config/config.js';
import { createLogger } from '../config/logging.js';
import { ApiResponseValidationError, TrialNotFoundError } from '../error/errors.js';
import { ProxyEndpointProvider } from '../http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../http/endpoint/proxy/httpProxyUrlParser.js';
import { createHttpClient } from '../http/httpClient.js';
import { UndiciTransportFactory } from '../http/transport/impl/undiciProxyTransport.js';
import { UrlBuilder } from '../http/urlPrepare.js';
import { validateNctId } from '../utils/validation.js';
import { FetchStudiesPageParams, FetchTrialDetailParams, StudiesPageResponse, Study } from './types.js';

const logger = createLogger(import.meta.url);

export interface ApiHttpClient {
    fetchJson(url: string, options?: { allow404?: boolean }): Promise<unknown | null>;
    close(): Promise<void>;
}

export interface ApiClient {
    fetchStudiesPage(params?: FetchStudiesPageParams): Promise<StudiesPageResponse>;

    fetchTrialDetail(nctId: string, params?: FetchTrialDetailParams): Promise<unknown>;

    close(): Promise<void>;
}

/**
 * Creates a production-ready API client with the application's configured
 * HTTP infrastructure.
 *
 * The HTTP client, proxy endpoint provider, transport factory, rate limiter,
 * and connection-pool configuration are intentionally hidden from callers.
 */
export async function createApiClient(): Promise<ApiClient> {
    const httpClient = await createHttpClient(
        {
            proxyUrls: PROXY_URLS,
            useRateLimit: true,
            rateLimitCapacity: RATE_LIMIT_CAPACITY,
            rateLimitWindow: RATE_LIMIT_WINDOW,
            acquireTimeout: ACQUIRE_TIMEOUT,
            concurrency: CONCURRENCY,
        },
        new ProxyEndpointProvider(
            new UndiciTransportFactory({ poolConfig: PROXY_POOL_CONFIG }),
            new HttpProxyUrlParser(),
            {
                proxyUrls: PROXY_URLS,
                concurrency: CONCURRENCY,
            },
        ),
    );

    try {
        const apiClient = createApiClientWithHttpClient(httpClient);

        logger.info({ apiBaseUrl: API_BASE_URL, apiDetailUrl: API_DETAIL_URL }, 'API client created');

        return apiClient;
    } catch (error) {
        await httpClient.close();
        throw error;
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
            { url, pageSize: params.pageSize ?? null, pageToken: params.pageToken ?? null },
            'Fetching studies page',
        );

        const data = await httpClient.fetchJson(url);

        const page = parseStudiesPageResponse(data, url);

        logger.debug(
            { url, studyCount: page.studies.length, nextPageToken: page.nextPageToken ?? null },
            'Studies page fetched',
        );

        return page;
    }

    async function fetchTrialDetail(nctId: string, params: FetchTrialDetailParams = {}): Promise<unknown> {
        const normalizedNctId = validateNctId(nctId);

        const url = new UrlBuilder(API_DETAIL_URL).path(normalizedNctId).queryParams(params).build();

        logger.debug({ nctId: normalizedNctId, url }, 'Fetching trial detail');

        const data = await httpClient.fetchJson(url, { allow404: true });

        if (data === null) {
            logger.debug({ nctId: normalizedNctId }, 'Trial not found (404)');

            throw new TrialNotFoundError(normalizedNctId);
        }

        logger.debug({ nctId: normalizedNctId }, 'Trial detail fetched');

        return data;
    }

    async function close(): Promise<void> {
        await httpClient.close();
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
