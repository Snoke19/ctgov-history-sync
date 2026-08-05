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

    fetchTrialDetail(nctId: string, params?: FetchTrialDetailParams): Promise<unknown>;
}

export function createApiClient({ fetchJson }: ApiClientDependencies): ApiClient {
    async function fetchStudiesPage(
        params: FetchStudiesPageParams = {},
    ): Promise<StudiesPageResponse> {
        const url = new UrlBuilder(API_BASE_URL).queryParams(params).build();

        const data = await fetchJson(url);
        return data as StudiesPageResponse;
    }

    async function fetchTrialDetail(
        nctId: string,
        params: FetchTrialDetailParams = {},
    ): Promise<unknown> {
        validateNctId(nctId);

        const url = new UrlBuilder(API_DETAIL_URL).path(nctId).queryParams(params).build();

        const data = await fetchJson(url, { allow404: true });

        if (data === null) {
            throw new TrialNotFoundError(nctId);
        }

        return data;
    }

    return { fetchStudiesPage, fetchTrialDetail };
}
