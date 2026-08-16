import { randomUUID } from 'node:crypto';
import type { ApiClient } from './api/api.js';
import type { Study } from './api/types.js';
import { withLogContext } from './config/logContext.js';
import { createLogger } from './config/logging.js';
import { HttpException, NetworkException, TimeoutException, TrialError, TrialNotFoundError } from './error/errors.js';

const correlationId = randomUUID();
const logger = createLogger(import.meta.url);

const DATE_RANGE = 'AREA[StartDate]RANGE[07/17/2026, 07/18/2026]';

let resumePageToken: string | undefined = '';
let pageNum = 1;

async function withConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
    const results: (R | null)[] = new Array(items.length);
    const queue = items.map((item, i) => ({ item, i }));

    async function worker(): Promise<void> {
        while (queue.length > 0) {
            const next = queue.shift();

            if (next === undefined) {
                break;
            }

            const { item, i } = next;

            try {
                results[i] = await fn(item);
            } catch (err: unknown) {
                logger.warn({ item: String(item), err }, 'Concurrent item processing recovered with null result');

                results[i] = null;
            }
        }
    }

    const workerCount = Math.min(limit, items.length);

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}

async function fetchTrialSafe(api: ApiClient, nctId: string) {
    const startedAt = Date.now();

    try {
        return await api.fetchTrialDetail(nctId, { history: true });
    } catch (err: unknown) {
        const durationMs = Date.now() - startedAt;

        if (err instanceof TrialNotFoundError) {
            logger.debug({ nctId, durationMs }, 'Trial not found');
            return null;
        }

        if (err instanceof TimeoutException) {
            logger.warn({ nctId, durationMs }, 'Trial fetch timed out');
            return null;
        }

        if (err instanceof HttpException) {
            logger.warn({ nctId, status: err.status, durationMs }, 'Trial fetch returned HTTP error');
            return null;
        }

        if (err instanceof NetworkException) {
            logger.warn({ nctId, durationMs, cause: getErrorMessage(err.cause) }, 'Trial fetch network error');
            return null;
        }

        if (err instanceof TrialError) {
            logger.warn({ nctId, durationMs, cause: getErrorMessage(err.cause) }, 'Trial fetch failed');
            return null;
        }

        logger.error({ nctId, durationMs, err }, 'Trial fetch failed with unexpected error');

        return null;
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

async function scrape(api: ApiClient, pageSize: number, concurrency: number): Promise<void> {
    const startedAt = Date.now();

    const initialToken = resumePageToken;

    let totalStudies = 0;
    let totalSaved = 0;
    let totalFailed = 0;

    const firstPage = await api.fetchStudiesPage({
        pageSize,
        countTotal: true,
        'query.term': DATE_RANGE,
        ...(initialToken && { pageToken: initialToken }),
    });

    if (!initialToken) {
        // eslint-disable-next-line require-atomic-updates -- initialToken is a local snapshot
        resumePageToken = firstPage.nextPageToken;
    }

    let currentStudies = firstPage.studies ?? [];
    let nextToken = initialToken ?? firstPage.nextPageToken;

    while (true) {
        const pageStartedAt = Date.now();

        logger.info(
            {
                page: pageNum,
                studyCount: currentStudies.length,
                hasPageToken: Boolean(nextToken),
            },
            'Processing page',
        );

        const nctIds = currentStudies
            .map((study: Study) => study.protocolSection?.identificationModule?.nctId)
            .filter((id): id is string => id !== undefined);

        const details = await withConcurrency(nctIds, concurrency, (nctId) => fetchTrialSafe(api, nctId));

        const validDetails = details.filter(<T>(detail: T): detail is NonNullable<T> => detail !== null);

        totalStudies += nctIds.length;
        totalSaved += validDetails.length;
        totalFailed += nctIds.length - validDetails.length;

        logger.info(
            {
                page: pageNum,
                fetched: nctIds.length,
                saved: validDetails.length,
                failed: nctIds.length - validDetails.length,
                durationMs: Date.now() - pageStartedAt,
            },
            'Page processed',
        );

        if (!nextToken) {
            break;
        }

        const nextPage = await api.fetchStudiesPage({
            pageSize,
            pageToken: nextToken,
            countTotal: true,
            'query.term': DATE_RANGE,
        });

        currentStudies = nextPage.studies ?? [];
        nextToken = nextPage.nextPageToken;
        pageNum++;

        if (currentStudies.length === 0) {
            break;
        }
    }

    // eslint-disable-next-line require-atomic-updates -- checkpoint written once at function end
    resumePageToken = nextToken;

    logger.info(
        {
            page: pageNum,
            hasNextPageToken: Boolean(nextToken),
        },
        'Checkpoint state updated',
    );

    logger.info(
        {
            totalPages: pageNum,
            totalStudies,
            totalSaved,
            totalFailed,
            successRatePct: totalStudies > 0 ? Math.round((totalSaved / totalStudies) * 1000) / 10 : null,
            totalDurationMs: Date.now() - startedAt,
        },
        'Scrape completed',
    );
}

process.on('SIGINT', () => {
    logger.warn('Interrupt signal received; terminating scraper');

    // eslint-disable-next-line n/no-process-exit -- intentional immediate termination on Ctrl-C
    process.exit(130);
});

async function run(): Promise<void> {
    let api: ApiClient | undefined;

    try {
        // Load configuration lazily so required-configuration failures surface here,
        // at the application boundary, where they can be logged with full context.
        const { CONCURRENCY, PAGE_SIZE } = await import('./config/config.js');
        const { createApiClient } = await import('./api/api.js');

        logger.info({ dateRange: DATE_RANGE, pageSize: PAGE_SIZE, concurrency: CONCURRENCY }, 'Scraper starting');

        api = await createApiClient();

        logger.info('Scraper API client initialized');

        await scrape(api, PAGE_SIZE, CONCURRENCY);
    } catch (err: unknown) {
        if (err instanceof Error) {
            logger.error({ err, cause: getErrorMessage(err.cause) }, 'Scraper failed');
        } else {
            logger.error({ error: String(err) }, 'Scraper failed');
        }

        process.exitCode = 1;
    } finally {
        logger.info('Scraper shutting down');

        try {
            await api?.close();
            logger.info('Scraper shutdown completed');
        } catch (error: unknown) {
            logger.error({ err: error }, 'Scraper shutdown failed');
            process.exitCode = 1;
        }
    }
}

void withLogContext({ correlationId, operation: 'scrape' }, run);
