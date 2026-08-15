import { createApiClient } from './api/api.js';
import { Study } from './api/types.js';
import { CONCURRENCY, PAGE_SIZE } from './config/config.js';
import { logger } from './config/logging.js';
import { HttpException, NetworkException, TimeoutException, TrialError, TrialNotFoundError } from './error/errors.js';

const DATE_RANGE = 'AREA[StartDate]RANGE[07/15/2026, 07/18/2026]';

const api = await createApiClient();

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
                logger.warn(`Error processing ${String(item)}: ${err instanceof Error ? err.message : String(err)}`);

                results[i] = null;
            }
        }
    }

    const workerCount = Math.min(limit, items.length);

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}

async function fetchTrialSafe(nctId: string) {
    try {
        return await api.fetchTrialDetail(nctId, { history: true });
    } catch (err: unknown) {
        if (err instanceof TrialNotFoundError) {
            logger.warn(`Not found: ${nctId}`);
            return null;
        }

        if (err instanceof TimeoutException) {
            logger.warn(`Timeout: ${nctId}`);
            return null;
        }

        if (err instanceof HttpException) {
            logger.warn(`HTTP ${err.status}: ${nctId}`);
            return null;
        }

        if (err instanceof NetworkException) {
            logger.warn(`Network error: ${nctId} — ${getErrorMessage(err.cause)}`);
            return null;
        }

        if (err instanceof TrialError) {
            logger.warn(`Failed: ${nctId} — ${getErrorMessage(err.cause)}`);
            return null;
        }

        logger.error(`Unexpected error for ${nctId}: ${getErrorMessage(err)}`);

        return null;
    }
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

process.on('SIGINT', () => {
    logger.info('Interrupted, saving checkpoint…');

    // eslint-disable-next-line n/no-process-exit -- intentional immediate termination on Ctrl-C
    process.exit(0);
});

async function main(): Promise<void> {
    const initialToken = resumePageToken;

    const firstPage = await api.fetchStudiesPage({
        pageSize: PAGE_SIZE,
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
        logger.info(
            `Processing page ${pageNum} (${currentStudies.length} studies, pageToken=${nextToken ?? 'none'})...`,
        );

        const nctIds = currentStudies
            .map((study: Study) => study.protocolSection?.identificationModule?.nctId)
            .filter((id): id is string => id !== undefined);

        const details = await withConcurrency(nctIds, CONCURRENCY, fetchTrialSafe);

        const validDetails = details.filter(<T>(detail: T): detail is NonNullable<T> => detail !== null);

        logger.info(
            `Page ${pageNum}: Fetched ${nctIds.length}, Saved ${
                validDetails.length
            }, Failed ${nctIds.length - validDetails.length}`,
        );

        if (!nextToken) {
            break;
        }

        const nextPage = await api.fetchStudiesPage({
            pageSize: PAGE_SIZE,
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
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (err: unknown) {
        if (err instanceof TrialError) {
            logger.error(`Trial error: ${err.message}`);

            if (err.cause instanceof Error) {
                logger.error(`Cause: ${err.cause.message}`);
            }

            if (err.stack) {
                logger.error(err.stack);
            }
        } else if (err instanceof Error) {
            logger.error(`Unexpected error: ${err.message}`);

            if (err.stack) {
                logger.error(err.stack);
            }
        } else {
            logger.error(`Unexpected error: ${String(err)}`);
        }

        process.exitCode = 1;
    } finally {
        await api.close();
    }
}
void run();
