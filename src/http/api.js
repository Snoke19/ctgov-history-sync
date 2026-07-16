import {API_BASE_URL, API_DETAIL_URL} from '../config/config.js';
import {UrlBuilder} from './urlPrepare.js';
import {TrialNotFoundError, TrialValidationError} from '../error/errors.js';
import {fetchWithRetry, parseJsonResponse} from './httpClient.js';
import {cleanParams} from "./cleanParams.js";
import {validateGeoDecay, validateGeoFilter, validatePageSize} from "../validators.js";

export async function fetchStudiesPage(params = {pageSize: 10}) {
    const cleaned = cleanParams(params);

    if ('pageSize' in cleaned) validatePageSize(cleaned.pageSize);
    if (cleaned['filter.geo']) validateGeoFilter(cleaned['filter.geo'], 'filter.geo');
    if (cleaned['postFilter.geo']) validateGeoFilter(cleaned['postFilter.geo'], 'postFilter.geo');
    if (cleaned['geoDecay']) validateGeoDecay(cleaned['geoDecay']);

    const url = new UrlBuilder(API_BASE_URL)
        .queryParams(cleaned)
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
