import {logger} from './logging.js';
import {API_BASE_URL, FETCH_TIMEOUT_MS} from './config.js';
import {UrlBuilder} from './urlPrepare.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from './errors.js';
import {withRetry} from "./retry.js";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

async function httpGet(url, timeoutMs) {
    return withRetry(
        async () => {
            logger.info(`Url fetched ${url}`);
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
                    const err = new TrialTimeoutError(url, timeoutMs);
                    err.isTransient = true;
                    throw err;
                }
                throw new TrialFetchError(url, error);
            }

            if (!RETRYABLE_STATUS_CODES.has(response.status)) {
                return response;
            }

            const error = new TrialFetchError(url, new Error(`HTTP ${response.status}`), response.status);
            error.isTransient = true;

            if (response.status === 429) {
                const retryAfter = response.headers.get('Retry-After');
                if (retryAfter) {
                    error.retryAfterMs = parseInt(retryAfter, 10) * 1000;
                }
            }

            throw error;
        }, {
            attempts: 4,
            baseDelayMs: 1500,
            shouldRetry: (error) => error.isTransient === true,
            getRequestedDelay: (error) => error.retryAfterMs,
            onRetry: (attempt, maxAttempts, waitMs, error) => {
                const reason = error.status === 429 ? 'Rate Limited' : 'Transient Error';
                logger.warn(`[${reason}] ${url} - Attempt ${attempt}/${maxAttempts} failed. Retrying in ${(waitMs / 1000).toFixed(1)}s`);
            }
        })
}

export async function fetchTrials(from = 0, limit = 10) {
    const url = new UrlBuilder(API_BASE_URL)
        .queryParam('from', from)
        .queryParam('limit', limit)
        .build();

    const response = await httpGet(url, FETCH_TIMEOUT_MS);

    if (!response.ok) {
        throw new TrialFetchError(url, new Error(`HTTP ${response.status}: ${response.statusText}`), response.status);
    }

    return await response.json();
}

export async function fetchTrial(code, params = {}) {
    const url = new UrlBuilder(API_BASE_URL)
        .path(code)
        .queryParams(params)
        .build();

    const response = await httpGet(url, FETCH_TIMEOUT_MS);

    if (response.status === 404) throw new TrialNotFoundError(code);

    if (!response.ok) {
        throw new TrialFetchError(url, new Error(`HTTP ${response.status}: ${response.statusText}`), response.status);
    }

    return await response.json();
}
