import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { Logger, LoggerOptions, TransportMultiOptions } from 'pino';
import { defaults } from './defaults.js';

const projectRoot = dirname(fileURLToPath(import.meta.url));

function envStr(key: string, fallback: string): string {
    const value = process.env[key];
    return value === undefined || value === '' ? fallback : value.trim();
}

export function createLogger(moduleUrl: string): Logger {
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

        transport: {
            targets,
        },
    };

    return pino(options).child({
        logger: filename,
    });
}
