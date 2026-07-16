import {fetchStudiesPage, fetchTrialDetail} from './api.js';
import {logger} from './logging.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from './errors.js';
import {CONCURRENCY, PAGE_SIZE} from './config.js';

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
    const firstPage = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
    });

    const total = firstPage.totalCount ?? 0;
    logger.info(`Total studies: ${total.toString()}`);

    let pageToken = firstPage.nextPageToken;
    let currentStudies = firstPage.studies ?? [];
    let pageNum = 1;

    while (true) {
        logger.info(`Processing page ${pageNum} (${currentStudies.length} studies, pageToken=${pageToken ?? 'none'})...`);

        let records;

        if (FETCH_DETAILS) {
            // Fan out CONCURRENCY workers to fetch per-trial detail
            const nctIds = currentStudies.map(s => s.protocolSection?.identificationModule?.nctId).filter(Boolean);
            const details = await withConcurrency(nctIds, CONCURRENCY, (nctId) =>
                fetchTrialSafe(nctId)
            );
            records = details.filter(Boolean);
        } else {
            records = currentStudies;
        }

        const failed = currentStudies.length - records.length;

        pagesDone = pageNum;

        logger.info(`Page ${pageNum} done: ${records.length} written, ${failed} failed `);

        if (!pageToken) break;

        const nextPage = await fetchStudiesPage({
            pageSize: PAGE_SIZE,
            pageToken,
        });

        pageToken = nextPage.nextPageToken;
        currentStudies = nextPage.studies ?? [];
        pageNum++;

        if (!currentStudies.length) break;
    }
} catch (err) {
    if (err instanceof TrialFetchError) {
        const status = err.status ? ` [HTTP ${err.status}]` : '';
        logger.error(`Fetch error${status}: ${err.url} — ${err.cause?.message ?? ''}`);
    } else {
        logger.error(`Unexpected: ${err.message}`);
    }
    process.exit(1);
}
