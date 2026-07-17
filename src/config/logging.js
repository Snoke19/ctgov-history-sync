import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    transport: isProduction
        ? undefined
        : {
              target: 'pino-pretty',
              options: {
                  colorize: true,
                  translateTime: 'HH:MM:ss.l',
                  messageFormat: '[{service}] {msg}',
                  ignore: 'service',
              },
          },
    base: {
        service: 'clinical-trials-scrap',
    },
    ...(isProduction && { errorKey: 'err' }),
});
