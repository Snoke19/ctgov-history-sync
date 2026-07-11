import {logger} from './logging.js';

const API_BASE_URL = 'https://clinicaltrials.gov/api/int/studies';
const FETCH_TIMEOUT_MS = 20_000;

function buildUrl(code, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return `${API_BASE_URL}/${encodeURIComponent(code)}${qs ? `?${qs}` : ''}`;
}

async function fetchClinicalTrials(baseUrl, code, params) {
    const url = buildUrl(code, params);
    logger.debug(`Fetching ${url}`);

    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            method: 'GET',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'ClinicalTrialsScraper/1.0',
            },
        });

        if (response.status === 404) {
            logger.warn(`Study not found (404): ${code}`);
            return null;
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        logger.info(`Fetched ${code}`);
        return data;
    } catch (error) {
        const msg = error.name === 'TimeoutError'
            ? `Timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`
            : `Failed to fetch ${code}: ${error.message}`;
        logger.error(msg);
        throw error;
    }
}

try {
    const data = await fetchClinicalTrials(API_BASE_URL, 'NCT07697053', { history: true });
    logger.info(data?.history.changes.length);
} catch (err) {
    logger.error(`Error: ${err.message}`);
}
