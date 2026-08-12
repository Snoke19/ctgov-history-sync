import { createApiClient } from './api/api.js';
import {
    ACQUIRE_TIMEOUT,
    CONCURRENCY,
    PAGE_SIZE,
    PROXY_POOL_CONFIG,
    PROXY_URLS,
    RATE_LIMIT_CAPACITY,
    RATE_LIMIT_WINDOW,
} from './config/config.js';
import { logger } from './config/logging.js';
import { HttpException, NetworkException, TimeoutException, TrialFetchError, TrialNotFoundError } from './error/errors.js';
import { ProxyEndpointProvider } from './http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from './http/endpoint/proxy/httpProxyUrlParser.js';
import { UndiciTransportFactory } from './http/endpoint/transport/impl/undiciProxyTransport.js';
import { createHttpClient } from './http/httpClient.js';

const DATE_RANGE = 'AREA[StartDate]RANGE[07/15/2026, 07/18/2026]';

const httpClient = createHttpClient(
    {
        proxyUrls: PROXY_URLS,
        useRateLimit: true,
        rateLimitCapacity: RATE_LIMIT_CAPACITY,
        rateLimitWindow: RATE_LIMIT_WINDOW,
        acquireTimeout: ACQUIRE_TIMEOUT,
        concurrency: CONCURRENCY,
        poolConfig: PROXY_POOL_CONFIG,
    },
    new ProxyEndpointProvider(new UndiciTransportFactory(), new HttpProxyUrlParser()),
);

const api = createApiClient(httpClient);

// State for checkpoint
let pageToken: string | undefined = '';
let pageNum = 1;

async function withConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>) {
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

        if (err instanceof TrialFetchError) {
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

// Register SIGINT handler once at the start
process.on('SIGINT', async () => {
    logger.info('Interrupted, saving checkpoint…');
    process.exit(0);
});

async function main(): Promise<void> {
    const firstPage = await api.fetchStudiesPage({
        pageSize: PAGE_SIZE,
        countTotal: true,
        'query.term': DATE_RANGE,
        ...(pageToken && { pageToken }),
    });

    if (!pageToken) {
        // First page of fresh scrape
        pageToken = firstPage.nextPageToken;
    }

    let currentStudies = firstPage.studies ?? [];

    while (true) {
        logger.info(
            `Processing page ${pageNum} (${currentStudies.length} studies, pageToken=${pageToken ?? 'none'})...`,
        );

        const nctIds = currentStudies
            .map((study: any) => study.protocolSection?.identificationModule?.nctId)
            .filter((id: any): id is string => id !== undefined);

        const details = await withConcurrency(nctIds, CONCURRENCY, fetchTrialSafe);

        const validDetails = details.filter(<T>(detail: T): detail is NonNullable<T> => detail !== null);

        logger.info(
            `Page ${pageNum}: Fetched ${nctIds.length}, Saved ${validDetails.length}, Failed ${nctIds.length - validDetails.length}`,
        );

        if (!pageToken) {
            break;
        }

        const nextPage = await api.fetchStudiesPage({
            pageSize: PAGE_SIZE,
            pageToken,
            countTotal: true,
            'query.term': DATE_RANGE,
        });

        pageToken = nextPage.nextPageToken;
        currentStudies = nextPage.studies ?? [];
        pageNum++;

        if (currentStudies.length === 0) {
            break;
        }
    }
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (err: unknown) {
        if (err instanceof TrialFetchError) {
            const status = err.status ? ` [HTTP ${err.status}]` : '';

            logger.error(
                `Fetch error${status}: ${err.url} — ${
                    err.cause instanceof Error ? err.cause.message : String(err.cause ?? '')
                }`,
            );
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
        await httpClient.close();
    }
}

void run();
