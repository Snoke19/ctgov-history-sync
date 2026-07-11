import {fetchTrial, fetchTrials} from './api.js';
import {logger} from './logging.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from './errors.js';

const PAGE_SIZE = 100;
const API_MAX_OFFSET = 10_000;
const CONCURRENCY = 100;

async function withConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    const queue = items.map((item, i) => ({item, i}));

    async function worker() {
        while (queue.length) {
            const {item, i} = queue.shift();
            results[i] = await fn(item);
        }
    }

    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
    return results;
}

async function fetchTrialSafe(hit) {
    try {
        return await fetchTrial(hit.id, {history: true});
    } catch (err) {
        if (err instanceof TrialNotFoundError) {
            logger.warn(`Not found: ${hit.id}`);
            return null;
        }
        if (err instanceof TrialTimeoutError) {
            logger.warn(`Timeout: ${hit.id}`);
            return null;
        }
        if (err instanceof TrialFetchError) {
            logger.warn(`Failed: ${hit.id} — ${err.cause?.message}`);
            return null;
        }
        throw err;
    }
}

try {
    const start = performance.now();
    const allData = [];
    let from = 0;
    let total = Infinity;

    const limit = Math.min(PAGE_SIZE, API_MAX_OFFSET - from);
    logger.info(`Fetching page from=${from} limit=${limit}...`);

    const results = await fetchTrials(from, limit);
    const hits = results.hits ?? [];
    total = results.total;

    logger.info(`Page done - ${hits.length} hits (${from + hits.length}/${total}), fetching details...`);

    const pageData = await withConcurrency(hits, CONCURRENCY, fetchTrialSafe);
    allData.push(...pageData.filter(Boolean));

    logger.info(`Details done - ${allData.length} collected so far`);

    from += hits.length;  // advance by actual hits, not limit


    const elapsed = (performance.now() - start).toFixed(0);
    logger.info(`Done - ${allData.length} trials in ${elapsed}ms`);

} catch (err) {
    if (err instanceof TrialFetchError) {
        const status = err.status ? ` [HTTP ${err.status}]` : '';
        logger.error(`Fetch error${status}: ${err.url} — ${err.cause?.message ?? ''}`);
    } else {
        logger.error(`Unexpected: ${err.message}`);
    }
}
