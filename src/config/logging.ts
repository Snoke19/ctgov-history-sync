import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, { Logger, LoggerOptions } from 'pino';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export function createLogger(moduleUrl: string): Logger {
    const isProduction = process.env.NODE_ENV === 'production';
    const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

    const filename = relative(projectRoot, fileURLToPath(moduleUrl)).replaceAll('\\', '/');

    const options: LoggerOptions = {
        level: logLevel,

        base: {
            service: 'clinical-trials-scrap',
        },

        transport: {
            targets: [
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
                {
                    target: 'pino/file',
                    level: logLevel,
                    options: {
                        destination: './logs/app.log',
                        mkdir: true,
                    },
                },
            ],
        },
    };

    return pino(options).child({
        logger: filename,
    });
}
