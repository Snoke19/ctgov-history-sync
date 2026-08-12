import { API_BASE_URL, API_DETAIL_URL } from '../config/config.js';
import { TrialNotFoundError } from '../error/errors.js';
import { UrlBuilder } from '../http/urlPrepare.js';
import { validateNctId } from '../utils/validation.js';
import { FetchStudiesPageParams, FetchTrialDetailParams, StudiesPageResponse } from './types.js';

export interface FetchJsonOptions {
    allow404?: boolean;
}

export interface ApiClientDependencies {
    fetchJson(url: string, options?: FetchJsonOptions): Promise<unknown>;

    /**
     * Base URL for study-list pages. Defaults to the configured API_BASE_URL.
     * Injectable so callers (and tests) do not depend on module-level config.
     */
    apiBaseUrl?: string;

    /**
     * Base URL for single-study detail pages. Defaults to the configured
     * API_DETAIL_URL. Injectable so callers (and tests) do not depend on
     * module-level config.
     */
    apiDetailUrl?: string;
}

export interface ApiClient {
    fetchStudiesPage(params?: FetchStudiesPageParams): Promise<StudiesPageResponse>;

    fetchTrialDetail(nctId: string, params?: FetchTrialDetailParams): Promise<unknown>;
}

export function createApiClient({
    fetchJson,
    apiBaseUrl = API_BASE_URL,
    apiDetailUrl = API_DETAIL_URL,
}: ApiClientDependencies): ApiClient {
    async function fetchStudiesPage(params: FetchStudiesPageParams = {}): Promise<StudiesPageResponse> {
        const url = new UrlBuilder(apiBaseUrl).queryParams(params).build();

        const data = await fetchJson(url);
        return data as StudiesPageResponse;
    }

    async function fetchTrialDetail(nctId: string, params: FetchTrialDetailParams = {}): Promise<unknown> {
        validateNctId(nctId);

        const url = new UrlBuilder(apiDetailUrl).path(nctId).queryParams(params).build();

        const data = await fetchJson(url, { allow404: true });

        if (data === null) {
            throw new TrialNotFoundError(nctId);
        }

        return data;
    }

    return { fetchStudiesPage, fetchTrialDetail };
}
