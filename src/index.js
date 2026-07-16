import {fetchStudiesPage, fetchTrialDetail} from './http/api.js';
import {logger} from './config/logging.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from './error/errors.js';
import {PAGE_SIZE} from './config/config.js';

const FETCH_DETAILS = process.env.FETCH_DETAILS !== 'false'; // default: true

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

async function fetchTrialSafe(nctId) {
    try {
        return await fetchTrialDetail(nctId, {history: true});
    } catch (err) {
        if (err instanceof TrialNotFoundError) {
            logger.warn(`Not found: ${nctId}`);
            return null;
        }
        if (err instanceof TrialTimeoutError) {
            logger.warn(`Timeout: ${nctId}`);
            return null;
        }
        if (err instanceof TrialFetchError) {
            logger.warn(`Failed: ${nctId} — ${err.cause?.message}`);
            return null;
        }
        throw err;
    }
}

let pagesDone = 0;

try {
    logger.info('Fetching first page to discover total study count...');
    const firstPage1 = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    const firstPage2 = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    const firstPage3 = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    const firstPage4 = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    const firstPage5 = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    const firstPage6 = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    console.log("firstPage: " + firstPage.totalCount)

    const total = firstPage.totalCount ?? 0;
    logger.info(`Total studies: ${total.toString()}`);




} catch (err) {
    if (err instanceof TrialFetchError) {
        const status = err.status ? ` [HTTP ${err.status}]` : '';
        logger.error(`Fetch error${status}: ${err.url} — ${err.cause?.message ?? ''}`);
    } else {
        logger.error(`Unexpected: ${err.message}`);
    }
    process.exit(1);
}
