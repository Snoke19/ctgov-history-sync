import { randomUUID } from 'node:crypto';
import type { ApiClient } from './api/api.js';
import { createApiClient } from './api/api.js';
import { DEFAULT_DATE_RANGE, ScrapeUseCase } from './application/scrapeUseCase.js';
import { loadConfig } from './config/appConfig.js';
import { withLogContext } from './config/logContext.js';
import { createLogger } from './config/logging.js';

const correlationId = randomUUID();
const logger = createLogger(import.meta.url);

process.on('SIGINT', () => {
    logger.warn('Interrupt signal received; terminating scraper');

    // eslint-disable-next-line n/no-process-exit -- intentional immediate termination on Ctrl-C
    process.exit(130);
});

async function run(): Promise<void> {
    let api: ApiClient | undefined;

    try {
        const appConfig = loadConfig();

        logger.info(
            { dateRange: DEFAULT_DATE_RANGE, pageSize: appConfig.api.pageSize, concurrency: appConfig.http.concurrency },
            'Scraper starting',
        );

        api = await createApiClient(appConfig);

        logger.info('Scraper API client initialized');

        const scrapeUseCase = new ScrapeUseCase(api, {
            pageSize: appConfig.api.pageSize,
            concurrency: appConfig.http.concurrency,
            dateRange: DEFAULT_DATE_RANGE,
        });

        await scrapeUseCase.execute();
    } catch (err: unknown) {
        if (err instanceof Error) {
            logger.error({ err }, 'Scraper failed');
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
