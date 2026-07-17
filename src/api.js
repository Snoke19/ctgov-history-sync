import {API_BASE_URL, API_DETAIL_URL} from './config/config.js';
import {TrialNotFoundError} from './error/errors.js';
import {cleanParams} from "./http/cleanParams.js";
import {fetchJson} from './http/httpClient.js';
import {UrlBuilder} from './http/urlPrepare.js';
import {validateNctId, validateSearchParams} from "./validators.js";

export async function fetchStudiesPage(params = {}) {
    const cleaned = cleanParams({pageSize: 10, ...params});
    validateSearchParams(cleaned);

    const url = new UrlBuilder(API_BASE_URL).queryParams(cleaned).build();
    return fetchJson(url);
}

export async function fetchTrialDetail(nctId, params = {}) {
    validateNctId(nctId);

    const url = new UrlBuilder(API_DETAIL_URL).path(nctId).queryParams(params).build();
    const data = await fetchJson(url, {allow404: true});

    if (data === null) {
        throw new TrialNotFoundError(nctId);
    }

    return data;
}
