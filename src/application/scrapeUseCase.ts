import type { ApiClient } from '../api/api.js';
import type { Study } from '../api/types.js';
import { createLogger } from '../config/logging.js';
import { HttpException, NetworkException, TimeoutException, TrialError, TrialNotFoundError } from '../error/errors.js';

const logger = createLogger(import.meta.url);

export const DEFAULT_DATE_RANGE = 'AREA[StartDate]RANGE[07/17/2026, 07/18/2026]';

export interface ScrapeConfig {
    readonly pageSize: number;
    readonly concurrency: number;
    readonly dateRange: string;
}

export class ScrapeUseCase {
    private resumePageToken: string | undefined = '';
    private pageNum = 1;

    constructor(
        private readonly api: ApiClient,
        private readonly config: ScrapeConfig,
    ) {}

    async execute(): Promise<void> {
        const startedAt = Date.now();

        const initialToken = this.resumePageToken;

        let totalStudies = 0;
        let totalSaved = 0;
        let totalFailed = 0;

        const firstPage = await this.api.fetchStudiesPage({
            pageSize: this.config.pageSize,
            countTotal: true,
            'query.term': this.config.dateRange,
            ...(initialToken && { pageToken: initialToken }),
        });

        if (!initialToken) {
            this.resumePageToken = firstPage.nextPageToken;
        }

        let currentStudies = firstPage.studies ?? [];
        let nextToken = initialToken || firstPage.nextPageToken;

        while (true) {
            const pageStartedAt = Date.now();

            logger.info(
                {
                    page: this.pageNum,
                    studyCount: currentStudies.length,
                    hasPageToken: Boolean(nextToken),
                },
                'Processing page',
            );

            const nctIds = currentStudies
                .map((study: Study) => study.protocolSection?.identificationModule?.nctId)
                .filter((id): id is string => id !== undefined);

            const details = await this.withConcurrency(nctIds, this.config.concurrency, (nctId) =>
                this.fetchTrialSafe(nctId),
            );

            const validDetails = details.filter(<T>(detail: T): detail is NonNullable<T> => detail !== null);

            totalStudies += nctIds.length;
            totalSaved += validDetails.length;
            totalFailed += nctIds.length - validDetails.length;

            logger.info(
                {
                    page: this.pageNum,
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

            const nextPage = await this.api.fetchStudiesPage({
                pageSize: this.config.pageSize,
                pageToken: nextToken,
                countTotal: true,
                'query.term': this.config.dateRange,
            });

            currentStudies = nextPage.studies ?? [];
            nextToken = nextPage.nextPageToken;
            this.pageNum++;

            if (currentStudies.length === 0) {
                break;
            }
        }

        this.resumePageToken = nextToken;

        logger.info(
            {
                page: this.pageNum,
                hasNextPageToken: Boolean(nextToken),
            },
            'Checkpoint state updated',
        );

        logger.info(
            {
                totalPages: this.pageNum,
                totalStudies,
                totalSaved,
                totalFailed,
                successRatePct: totalStudies > 0 ? Math.round((totalSaved / totalStudies) * 1000) / 10 : null,
                totalDurationMs: Date.now() - startedAt,
            },
            'Scrape completed',
        );
    }

    private async fetchTrialSafe(nctId: string): Promise<unknown | null> {
        const startedAt = Date.now();

        try {
            return await this.api.fetchTrialDetail(nctId, { history: true });
        } catch (err: unknown) {
            const durationMs = Date.now() - startedAt;

            if (err instanceof TrialNotFoundError) {
                logger.debug({ nctId, durationMs }, 'Trial not found');
                return null;
            }

            if (err instanceof TimeoutException) {
                logger.warn({ nctId, durationMs, err }, 'Trial fetch timed out');
                return null;
            }

            if (err instanceof HttpException) {
                logger.warn({ nctId, status: err.status, durationMs, err }, 'Trial fetch returned HTTP error');
                return null;
            }

            if (err instanceof NetworkException) {
                logger.warn({ nctId, durationMs, err }, 'Trial fetch network error');
                return null;
            }

            if (err instanceof TrialError) {
                logger.warn({ nctId, durationMs, err }, 'Trial fetch failed');
                return null;
            }

            logger.error({ nctId, durationMs, err }, 'Trial fetch failed with unexpected error');

            return null;
        }
    }

    private async withConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | null)[]> {
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
                    logger.error({ item: String(item), err }, 'Concurrent item processing failed unexpectedly');

                    results[i] = null;
                }
            }
        }

        const workerCount = Math.min(limit, items.length);

        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        return results;
    }
}
