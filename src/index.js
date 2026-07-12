import {fetchStudiesPage, fetchTrialDetail} from './api.js';
import {RateLimiter} from './rateLimiter.js';
import {ProgressTracker} from './progress.js';
import {logger} from './logging.js';
import {TrialFetchError, TrialNotFoundError, TrialTimeoutError} from './errors.js';
import {CONCURRENCY, PAGE_SIZE, PROGRESS_INTERVAL_MS,} from './config.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const FETCH_DETAILS = process.env.FETCH_DETAILS !== 'false'; // default: true

/**
 * Proactive inter-request gap for the detail (internal) API in ms.
 * Limits aggregate throughput to avoid triggering 429s before they happen.
 * With CONCURRENCY=15 and MIN_GAP_MS=100, peak rate = 10 req/s.
 * Set to 0 to disable (rely purely on reactive 429 handling).
 * Override: MIN_GAP_MS=50 node src/index.js
 */
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS ?? (FETCH_DETAILS ? 100 : 0));

// ─── Concurrency pool ─────────────────────────────────────────────────────────

/**
 * Run `fn` over every item in `items` with at most `limit` concurrent calls.
 * Results array preserves input order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function withConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    const queue = items.map((item, i) => ({item, i}));

    async function worker() {
        while (queue.length) {
            const {item, i} = queue.shift();
            results[i] = await fn(item);
        }
    }

    await Promise.all(
        Array.from({length: Math.min(limit, items.length)}, worker)
    );
    return results;
}

// ─── Per-trial detail fetch (safe — errors return null) ───────────────────────

/**
 * @param {string} nctId
 * @param {RateLimiter} rateLimiter
 * @returns {Promise<object|null>}
 */
async function fetchTrialSafe(nctId, rateLimiter) {
    try {
        return await fetchTrialDetail(nctId, {history: true}, rateLimiter);
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

// ─── Main ─────────────────────────────────────────────────────────────────────

const rateLimiter = new RateLimiter(MIN_GAP_MS);
let progress = null;
let outStream = null;
let pagesDone = 0;

// Graceful shutdown: log where we are on Ctrl-C
process.on('SIGINT', () => {
    logger.warn(`\nInterrupted after ${pagesDone} pages.`);
    if (progress) progress.print();
    if (outStream) outStream.end();
    process.exit(0);
});

try {
    const runStart = performance.now();

    // ── Phase 1: first page to discover totalCount ─────────────────────────
    logger.info('Fetching first page to discover total study count...');
    const firstPage = await fetchStudiesPage({
        pageSize: PAGE_SIZE,
        rateLimiter,
    });

    const total = firstPage.totalCount ?? 0;
    logger.info(`Total studies: ${total.toString()}`);

    progress = new ProgressTracker(total, PROGRESS_INTERVAL_MS);

    // ── Phase 2: process first page + all subsequent pages ─────────────────
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
                fetchTrialSafe(nctId, rateLimiter)
            );
            records = details.filter(Boolean);
        } else {
            // Use the list-API payload directly (no per-trial call)
            records = currentStudies;
        }

        const failed = currentStudies.length - records.length;
        progress.tick(currentStudies.length);
        if (failed > 0) progress.tick(0, true); // mark failures without double-counting done

        pagesDone = pageNum;

        logger.info(
            `Page ${pageNum} done: ${records.length} written, ${failed} failed ` +
            `(total so far: ${progress.done.toString()}/${total.toString()})`
        );

        // Check if there are more pages
        if (!pageToken) break;

        // ── Fetch next page while workers are free ─────────────────────────
        const nextPage = await fetchStudiesPage({
            pageSize: PAGE_SIZE,
            pageToken,
            rateLimiter,
        });

        pageToken = nextPage.nextPageToken;
        currentStudies = nextPage.studies ?? [];
        pageNum++;

        if (!currentStudies.length) break;
    }

    // ── Done ──────────────────────────────────────────────────────────────
    progress.print();

    const elapsed = ((performance.now() - runStart) / 1000).toFixed(1);
    logger.info(
        `✓ Complete:(${(progress.done / Number(elapsed)).toFixed(1)} studies/sec avg) ` +
        `| 429s seen: ${rateLimiter.throttleCount}`
    );

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
