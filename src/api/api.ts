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
}

export interface ApiClient {
    fetchStudiesPage(params?: FetchStudiesPageParams): Promise<StudiesPageResponse>;

    fetchTrialDetail(nctId: string, params?: FetchTrialDetailParams): Promise<import('./types.js').TrialDetail>;
}

export function createApiClient({ fetchJson }: ApiClientDependencies): ApiClient {
    async function fetchStudiesPage(params: FetchStudiesPageParams = {}): Promise<StudiesPageResponse> {
        const url = new UrlBuilder(API_BASE_URL).queryParams(params).build();

        const data = await fetchJson(url);
        return data as StudiesPageResponse;
    }

    async function fetchTrialDetail(nctId: string, params: FetchTrialDetailParams = {}): Promise<import('./types.js').TrialDetail> {
        // Normalize input before validation and request-building so callers may
        // pass case-insensitive or whitespace-padded values.
        const normalized = nctId.trim().toUpperCase();
        validateNctId(normalized);

        const url = new UrlBuilder(API_DETAIL_URL).path(normalized).queryParams(params).build();

        const data = await fetchJson(url, { allow404: true });

        if (data === null) {
            throw new TrialNotFoundError(normalized);
        }

        return data as import('./types.js').TrialDetail;
    }

    return { fetchStudiesPage, fetchTrialDetail };
}
