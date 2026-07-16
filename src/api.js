import {logger} from './logging.js';
import {
    API_BASE_URL,
    API_DETAIL_URL,
    DEFAULT_RETRY_AFTER_MS,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    RETRY_BASE_DELAY_MS,
} from './config.js';
import {UrlBuilder} from './urlPrepare.js';
import {TrialFetchError, TrialNotFoundError, TrialValidationError} from './errors.js';
import {fetch} from 'undici';
import {getRandomProxyDispatcher} from './readyIPs.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const DEFAULT_HEADERS = Object.freeze({
    Accept: 'application/json',
    'User-Agent': 'ClinicalTrialsScraper/1.0',
});

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter, capped at 30 s.
 * When a Retry-After hint is provided it takes priority.
 *
 * @param {number} attempt      - zero-indexed attempt number
 * @param {number|null} retryAfterMs
 * @returns {number} delay in ms
 */
function calculateBackoff(attempt, retryAfterMs = null) {
    if (retryAfterMs != null && retryAfterMs > 0) return retryAfterMs;
    const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, 30_000);
}

/**
 * Parses the Retry-After response header into milliseconds.
 * Handles both integer (seconds) and HTTP-date forms.
 *
 * @param {Response} response
 * @returns {number|null}
 */
function parseRetryAfterHeader(response) {
    const raw = response.headers.get('Retry-After');
    if (!raw) return null;

    const seconds = Number(raw);
    if (!Number.isNaN(seconds)) return seconds * 1000;

    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), DEFAULT_RETRY_AFTER_MS);

    return DEFAULT_RETRY_AFTER_MS;
}

/**
 * Fires a single HTTP GET. Applies proxy dispatcher when configured.
 * Throws TrialFetchError on network errors.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {object} [options.headers]
 * @returns {Promise<Response>}
 */
async function executeFetch(url, options = {}) {
    const proxyEntry = getRandomProxyDispatcher();

    const fetchOptions = {
        signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
        headers: {...DEFAULT_HEADERS, ...options.headers},
        ...(proxyEntry?.dispatcher && {dispatcher: proxyEntry.dispatcher}),
    };

    logger.debug('Fetching URL: %s | Proxy: %s', url, proxyEntry?.url ?? 'direct');

    try {
        return await fetch(url, fetchOptions);
    } catch (error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            const err = new TrialFetchError(url, error, null, true);
            err.isTimeout = true;
            throw err;
        }
        throw new TrialFetchError(url, error, null, true);
    }
}

/**
 * Executes `executeFetch` with automatic retries for transient failures.
 * Returns the raw Response on success.
 * Throws TrialFetchError after all retries are exhausted.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.maxRetries]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await executeFetch(url, options);

            if (!RETRYABLE_STATUS_CODES.has(response.status)) {
                return response; // includes non-ok non-retryable (e.g. 400, 404)
            }

            // Retryable HTTP status
            const retryAfterMs = response.status === 429
                ? (parseRetryAfterHeader(response) ?? DEFAULT_RETRY_AFTER_MS)
                : null;

            lastError = new TrialFetchError(
                url,
                new Error(`HTTP ${response.status}: ${response.statusText}`),
                response.status,
                true,
            );
            lastError.retryAfterMs = retryAfterMs;

            if (attempt < maxRetries) {
                const delay = calculateBackoff(attempt, retryAfterMs);
                logger.warn(
                    'Retryable HTTP %d — retrying in %dms (attempt %d/%d) | %s',
                    response.status, Math.round(delay), attempt + 1, maxRetries, url,
                );
                await sleep(delay);
            }
        } catch (error) {
            lastError = error;

            if (!error.isTransient || attempt >= maxRetries) throw error;

            const delay = calculateBackoff(attempt, error.retryAfterMs);
            logger.warn(
                'Transient error — retrying in %dms (attempt %d/%d) | %s | %s',
                Math.round(delay), attempt + 1, maxRetries, url, error.message,
            );
            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Parses a JSON response.
 * Throws TrialFetchError for non-ok responses (other than 404 when allow404=true).
 *
 * @param {Response} response
 * @param {string}   url        - for error messages
 * @param {object}   [opts]
 * @param {boolean}  [opts.allow404=false]
 * @returns {Promise<object>}
 */
async function parseJsonResponse(response, url, {allow404 = false} = {}) {
    if (allow404 && response.status === 404) {
        return null; // caller decides what to do
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new TrialFetchError(
            url,
            new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${text.slice(0, 200)}`),
            response.status,
            RETRYABLE_STATUS_CODES.has(response.status),
        );
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (!contentType.includes('application/json')) {
        logger.warn('Unexpected Content-Type: %s | %s', contentType, url);
    }

    try {
        return await response.json();
    } catch (parseError) {
        throw new TrialFetchError(
            url,
            new Error(`Invalid JSON: ${parseError.message}`),
            response.status,
            false,
        );
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────
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
