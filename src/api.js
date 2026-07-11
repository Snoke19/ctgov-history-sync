import {logger} from './logging.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from "./errors.js";
import {API_BASE_URL, FETCH_TIMEOUT_MS} from "./config.js";
import {UrlBuilder} from "./urlPrepare.js";

async function httpGet(url, timeoutMs) {
    logger.debug(`Fetching ${url}`);

    let response;
    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'ClinicalTrialsScraper/1.0',
            },
        });
    } catch (error) {
        if (error.name === 'TimeoutError') {
            throw new TrialTimeoutError(url, timeoutMs);
        }
        throw new TrialFetchError(url, error);
    }

    return response;
}

export async function fetchTrial(code, params = {}) {
    const url = new UrlBuilder(API_BASE_URL)
        .path(code)
        .queryParams(params)
        .build();

    const response = await httpGet(url, FETCH_TIMEOUT_MS);

    if (response.status === 404) {
        throw new TrialNotFoundError(code);
    }

    if (!response.ok) {
        throw new TrialFetchError(url, new Error(`HTTP ${response.status}: ${response.statusText}`));
    }

    const data = await response.json();
    logger.info(`Fetched ${code}`);
    return data;
}
