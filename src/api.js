import {API_BASE_URL, API_DETAIL_URL} from './config.js';
import {UrlBuilder} from './urlPrepare.js';
import {TrialNotFoundError, TrialValidationError} from './errors.js';
import {fetchWithRetry, parseJsonResponse} from './httpClient.js';

export async function fetchStudiesPage({pageSize, pageToken, fields} = {}) {
    if (!pageSize || pageSize < 1) {
        throw new TrialValidationError('pageSize must be a positive integer');
    }

    const url = new UrlBuilder(API_BASE_URL)
        .queryParam('pageSize', pageSize)
        .queryParam('countTotal', 'true')
        .queryParam('pageToken', pageToken)
        .queryParam('fields', fields?.join(','))
        .build();

    const response = await fetchWithRetry(url);
    return parseJsonResponse(response, url);
}

export async function fetchTrialDetail(nctId, params = {}) {
    if (!nctId || typeof nctId !== 'string') {
        throw new TrialValidationError('nctId must be a non-empty string');
    }

    const url = new UrlBuilder(API_DETAIL_URL)
        .path(nctId)
        .queryParams(params)
        .build();

    const response = await fetchWithRetry(url);

    if (response.status === 404) {
        throw new TrialNotFoundError(nctId);
    }

    return parseJsonResponse(response, url);
}
