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
import { TrialNotFoundError } from '../error/errors.js';
import { ProxyEndpointProvider } from '../http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../http/endpoint/proxy/httpProxyUrlParser.js';
import { createHttpClient } from '../http/httpClient.js';
import { UndiciTransportFactory } from '../http/transport/impl/undiciProxyTransport.js';
import { UrlBuilder } from '../http/urlPrepare.js';
import { validateNctId } from '../utils/validation.js';
import { parseStudiesPageResponse } from './responseValidation.js';
import { FetchStudiesPageParams, FetchTrialDetailParams, StudiesPageResponse } from './types.js';

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
            poolConfig: PROXY_POOL_CONFIG,
        },
        new ProxyEndpointProvider(new UndiciTransportFactory(), new HttpProxyUrlParser()),
    );

    try {
        return createApiClientWithHttpClient(httpClient);
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

        const data = await httpClient.fetchJson(url);

        return parseStudiesPageResponse(data, url);
    }

    async function fetchTrialDetail(nctId: string, params: FetchTrialDetailParams = {}): Promise<unknown> {
        const normalizedNctId = validateNctId(nctId);

        const url = new UrlBuilder(API_DETAIL_URL).path(normalizedNctId).queryParams(params).build();

        const data = await httpClient.fetchJson(url, { allow404: true });

        if (data === null) {
            throw new TrialNotFoundError(normalizedNctId);
        }

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
