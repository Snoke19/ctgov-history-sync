import {logger} from './logging.js';
import {API_BASE_URL, API_DETAIL_URL, DEFAULT_RETRY_AFTER_MS, FETCH_TIMEOUT_MS} from './config.js';
import {UrlBuilder} from './urlPrepare.js';
import {TrialFetchError, TrialTimeoutError} from './errors.js';
import {withRetry} from './retry.js';
import {fetch} from "undici";
import {getRandomProxyDispatcher} from "./readyIPs.js";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

async function httpGet(url, timeoutMs, rateLimiter) {
    return withRetry(
        async () => {
            await rateLimiter.wait();

            let response;
            const proxyEntry = getRandomProxyDispatcher();

            try {
                logger.info('url: ' + url);

                response = await fetch(url, {
                    signal: AbortSignal.timeout(timeoutMs),
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'ClinicalTrialsScraper/1.0',
                    },
                    dispatcher: proxyEntry ? proxyEntry.dispatcher : undefined
                });
            } catch (error) {
                console.error(error);
                if (error.name === 'TimeoutError') {
                    const err = new TrialTimeoutError(url, timeoutMs);
                    err.isTransient = true;
                    throw err;
                }
                const err = new TrialFetchError(url, error);
                err.isTransient = true;
                throw err;
            }

            if (!RETRYABLE_STATUS_CODES.has(response.status)) {
                return response;
            }

            const error = new TrialFetchError(url, new Error(`HTTP ${response.status}`), response.status);
            error.isTransient = true;

            if (response.status === 429) {
                const raw = response.headers.get('Retry-After');
                const retryAfterMs = raw
                    ? (isNaN(Number(raw)) ? Date.parse(raw) - Date.now() : Number(raw) * 1000)
                    : DEFAULT_RETRY_AFTER_MS;

                const safeMs = Math.max(retryAfterMs, DEFAULT_RETRY_AFTER_MS);
                error.retryAfterMs = safeMs;

                rateLimiter.reportThrottle(safeMs);
            }

            throw error;
        },
        {
            attempts: 6,
            baseDelayMs: 2000,
            maxDelayMs: 60_000,
            shouldRetry: (error) => error.isTransient === true,
            getRequestedDelay: (error) => error.retryAfterMs ?? null,
            onRetry: (attempt, maxAttempts, waitMs, error) => {
                const reason = error.status === 429 ? 'Rate Limited' : 'Transient Error';
                logger.warn(`[${reason}] ${url} - attempt ${attempt}/${maxAttempts}, retry in ${(waitMs / 1000).toFixed(1)}s`);
            },
        }
    );
}

export async function fetchStudiesPage({pageSize, pageToken, fields, rateLimiter}) {
    const builder = new UrlBuilder(API_BASE_URL)
        .queryParam('pageSize', pageSize)
        .queryParam('countTotal', 'true');

    if (pageToken) builder.queryParam('pageToken', pageToken);
    if (fields?.length) builder.queryParam('fields', fields.join(','));

    const url = builder.build();
    const response = await httpGet(url, FETCH_TIMEOUT_MS, rateLimiter);

    if (!response.ok) {
        throw new TrialFetchError(url, new Error(`HTTP ${response.status}: ${response.statusText}`), response.status);
    }

    return response.json();
}

export async function fetchTrialDetail(nctId, params = {}, rateLimiter) {
    const url = new UrlBuilder(API_DETAIL_URL)
        .path(nctId)
        .queryParams(params)
        .build();

    const response = await httpGet(url, FETCH_TIMEOUT_MS, rateLimiter);

    if (!response.ok) {
        throw new TrialFetchError(url, new Error(`HTTP ${response.status}: ${response.statusText}`), response.status);
    }

    return response.json();
}
