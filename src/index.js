import fetchStudiesPage, {fetchTrialDetail} from './http/api.js';
import {CONCURRENCY, PAGE_SIZE} from './config/config.js';
import {logger} from './config/logging.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from './error/errors.js';

try {
    logger.info(`Settings: CONCURRENCY=${CONCURRENCY}, PAGE_SIZE=${PAGE_SIZE}`);
    logger.info('Fetching first page to discover total study count…');
    const firstPage = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
        countTotal: true,
        'query.term': 'AREA[StartDate]RANGE[03/16/2026, 07/18/2026]'
    });

    const total = firstPage.totalCount ?? 0;
    logger.info(`Total studies: ${total.toString()}`);

    let pageToken = firstPage.nextPageToken;
    let currentStudies = firstPage.studies ?? [];
    let pageNum = 1;

    while (true) {
        logger.info(`Processing page ${pageNum} (${currentStudies.length} studies, pageToken=${pageToken ?? 'none'})...`);

        const nctIds = currentStudies.map(s => s.protocolSection?.identificationModule?.nctId).filter(Boolean);
        const details = await withConcurrency(nctIds, CONCURRENCY, (nctId) => fetchTrialSafe(nctId));

        logger.info(`Fetched items: ${details.length}`)

        if (!pageToken) break;

        const nextPage = await fetchStudiesPage({pageSize: PAGE_SIZE, pageToken});

        pageToken = nextPage.nextPageToken;
        currentStudies = nextPage.studies ?? [];
        pageNum++;

        if (!currentStudies.length) break;
    }

    logger.info(`✓ Complete:`);
} catch (err) {
    if (err instanceof TrialFetchError) {
        const status = err.status ? ` [HTTP ${err.status}]` : '';
        logger.error(`Fetch error${status}: ${err.url} — ${err.cause?.message ?? ''}`);
    } else {
        logger.error(`Unexpected error: ${err.message}`);
        logger.error(err.stack);
    }
    process.exit(1);
}

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
