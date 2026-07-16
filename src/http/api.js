import {API_BASE_URL, API_DETAIL_URL} from '../config/config.js';
import {UrlBuilder} from './urlPrepare.js';
import {TrialNotFoundError} from '../error/errors.js';
import {fetchWithRetry, parseJsonResponse} from './httpClient.js';
import {cleanParams} from "./cleanParams.js";
import {validateNctId, validateSearchParams} from "../validators.js";

export async function fetchStudiesPage(params = {}) {
    const cleaned = cleanParams({
        pageSize: 10,
        ...params,
    });

    validateSearchParams(cleaned);

    const url = new UrlBuilder(API_BASE_URL)
        .queryParams(cleaned)
        .build();

    const response = await fetchWithRetry(url);

    return parseJsonResponse(response, url);
}

export async function fetchTrialDetail(nctId, params = {}) {
    validateNctId(nctId);

    const url = new UrlBuilder(API_DETAIL_URL)
        .path(nctId)
        .queryParams(params)
        .build();

    const response = await fetchWithRetry(url);
    const data = await parseJsonResponse(response, url, {allow404: true});

    if (data === null) {
        throw new TrialNotFoundError(nctId);
    }

    return parseJsonResponse(response, url);
}
