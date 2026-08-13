import pino, { Logger, LoggerOptions } from 'pino';

const isProduction: boolean = process.env.NODE_ENV === 'production';

const pinoOptions: LoggerOptions = {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'trace'),
    base: {
        service: 'clinical-trials-scrap',
    },
    ...(!isProduction && {
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'HH:MM:ss.l',
                messageFormat: '[{service}] {msg}',
                ignore: 'service',
            },
        },
    }),
    ...(isProduction && {
        errorKey: 'err',
    }),
};

export const logger: Logger = pino(pinoOptions);
