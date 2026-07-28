import {API_BASE_URL, API_DETAIL_URL, PAGE_SIZE} from './config/config.js';
import {TrialNotFoundError} from './error/errors.js';
import {cleanParams} from './http/cleanParams.js';
import {fetchJson as defaultFetchJson} from './http/httpClient.js';
import {UrlBuilder} from './http/urlPrepare.js';
import {validateNctId, validateSearchParams} from './validators.js';

/**
 * Creates an API client with injectable dependencies for testability.
 *
 * @param {object} [deps={}]
 * @param {(url: string, options?: object) => Promise<object|null>} [deps.fetchJson]
 *   HTTP fetch function. Defaults to the shared production client. Inject a
 *   mock in tests to avoid touching the real HTTP stack.
 * @returns {{ fetchStudiesPage: Function, fetchTrialDetail: Function }}
 */
export function createApiClient({ fetchJson } = {}) {
    fetchJson = fetchJson ?? defaultFetchJson;

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

    return {fetchStudiesPage, fetchTrialDetail};
}

// Module-level default client — shares the production HTTP stack.
// index.js and other consumers import these directly without needing the factory.
const defaultClient = createApiClient();

export const fetchStudiesPage = defaultClient.fetchStudiesPage;
export const fetchTrialDetail = defaultClient.fetchTrialDetail;