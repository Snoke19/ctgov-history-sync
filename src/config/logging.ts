import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { Logger, LoggerOptions, TransportMultiOptions } from 'pino';
import { LOG_LEVEL, LOG_TO_FILE, NODE_ENV } from '../config/config.js';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export function createLogger(moduleUrl: string): Logger {
    const isProduction = NODE_ENV === 'production';
    const logLevel = LOG_LEVEL || (isProduction ? 'info' : 'debug');
    const logFileEnabled = LOG_TO_FILE === 'true';

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
