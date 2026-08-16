import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { DestinationStream, Logger, LoggerOptions, TransportMultiOptions } from 'pino';
import { defaults } from './defaults.js';
import { getLogContext } from './logContext.js';

const projectRoot = dirname(fileURLToPath(import.meta.url));

let testDestination: DestinationStream | undefined;

/**
 * Test-only hook. Redirects the destination of every logger created by
 * createLogger() to a custom stream (e.g. an in-memory sink) so tests can
 * assert on log records without reimplementing the pino configuration.
 */
export function setLoggerDestinationForTests(destination: DestinationStream | undefined): void {
    testDestination = destination;
}

function envStr(key: string, fallback: string): string {
    const value = process.env[key];
    return value === undefined || value === '' ? fallback : value.trim();
}

export function createLogger(moduleUrl: string, destination?: DestinationStream): Logger {
    const isProduction = envStr('NODE_ENV', defaults.NODE_ENV) === 'production';
    const logLevel = envStr('LOG_LEVEL', defaults.LOG_LEVEL) || (isProduction ? 'info' : 'debug');
    const logFileEnabled = envStr('LOG_TO_FILE', defaults.LOG_TO_FILE) === 'true';

    const filename = relative(projectRoot, fileURLToPath(moduleUrl)).replaceAll('\\', '/');

    const targets: TransportMultiOptions['targets'] = [
        {
            target: 'pino-pretty',
            level: logLevel,
            options: {
                colorize: !isProduction,
                translateTime: 'yyyy-mm-dd HH:MM:ss.l',
                singleLine: true,
                messageFormat: '[{service}] [{logger}] {msg}',
                ignore: 'pid,hostname',
            },
        },

        ...(logFileEnabled
            ? [
                  {
                      target: 'pino/file',
                      level: logLevel,
                      options: {
                          destination: './logs/app.log',
                          mkdir: true,
                      },
                  },
              ]
            : []),
    ];

    const options: LoggerOptions = {
        level: logLevel,

        base: {
            service: 'clinical-trials-scrap',
        },

        // Merge the AsyncLocalStorage logging context (correlationId,
        // requestId, operation) into every log record at write time.
        //
        // A fresh copy is returned because pino merges statement fields into
        // the mixin result with Object.assign. Returning the live ALS store
        // would mutate the shared context with statement-local data and
        // overwrite `operation` for every subsequent log record.
        mixin() {
            const context = getLogContext();

            return context === undefined ? {} : { ...context };
        },
    };

    const dest = destination ?? testDestination;

    // pino rejects a transport and a destination stream at the same time, so
    // the transport targets are only attached when no custom destination is
    // used (custom destinations are a test seam).
    const logger = dest === undefined ? pino({ ...options, transport: { targets } }) : pino(options, dest);

    return logger.child({
        logger: filename,
    });
}
