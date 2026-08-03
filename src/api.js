import {API_BASE_URL, API_DETAIL_URL, PAGE_SIZE} from './config/config.js';
import {TrialNotFoundError} from './error/errors.ts';
import {cleanParams} from './http/cleanParams.js';
import {UrlBuilder} from './http/urlPrepare.js';
import {validateNctId, validateSearchParams} from './utils/validators.ts';

/**
 * Creates an API client with injectable dependencies.
 *
 * @param {object} deps
 * @param {(url: string, options?: object) => Promise<object|null>} deps.fetchJson
 *   Function used to perform HTTP requests.
 * @returns {{
 *   fetchStudiesPage: (params?: object) => Promise<object>,
 *   fetchTrialDetail: (nctId: string, params?: object) => Promise<object>
 * }}
 */
export function createApiClient({fetchJson}) {

    if (typeof fetchJson !== 'function') {
        throw new TypeError('fetchJson must be a function');
    }

    /**
     * Fetches a paginated list of clinical studies matching the given params.
     *
     * @param {object} [params={}] - Query parameters forwarded to the API.
     *   `pageSize` defaults to the configured PAGE_SIZE value.
     * @returns {Promise<object>} Parsed JSON response from the studies endpoint.
     */
    async function fetchStudiesPage(params = {}) {
        const cleanedParams = cleanParams({pageSize: PAGE_SIZE, ...params});
        validateSearchParams(cleanedParams);

        const url = new UrlBuilder(API_BASE_URL).queryParams(cleanedParams).build();
        return fetchJson(url);
    }

    /**
     * Fetches the full detail record for a single clinical trial.
     *
     * @param {string} nctId - NCT identifier (e.g. "NCT12345678").
     * @param {object} [params={}] - Optional query parameters (e.g. `{ history: true }`).
     * @returns {Promise<object>} Parsed JSON detail record.
     * @throws {TrialNotFoundError} When the API returns 404 for the given nctId.
     */
    async function fetchTrialDetail(nctId, params = {}) {
        validateNctId(nctId);

        const cleanedParams = cleanParams({...params});
        validateSearchParams(cleanedParams);

        const url = new UrlBuilder(API_DETAIL_URL).path(nctId).queryParams(cleanedParams).build();
        const data = await fetchJson(url, {allow404: true});

        if (data === null) {
            throw new TrialNotFoundError(nctId);
        }

        return data;
    }

    return {
        fetchStudiesPage,
        fetchTrialDetail
    };
}