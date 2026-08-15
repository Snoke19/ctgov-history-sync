import { ConfigurationError } from '../error/errors.js';
import { assertNonNegativeInt, assertPositiveInt } from '../utils/validation.js';
import { createLogger } from './logging.js';

const logger = createLogger(import.meta.url);

const isInteger = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n);

const parseStrictInt = (raw: string, key: string): number => {
    const trimmed = raw.trim();

    if (!/^-?\d+$/.test(trimmed)) {
        throwConfigError(`Invalid integer value for ${key}: "${raw}"`, { key, type: 'integer' });
    }

    const parsed = Number(trimmed);

    if (!isInteger(parsed)) {
        throwConfigError(`Invalid integer value for ${key}: "${raw}"`, { key, type: 'integer' });
    }

    return parsed;
};

const getEnv = (key: string): string | undefined => {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : value;
};

function throwConfigError(message: string, context: Record<string, unknown>): never {
    const error = new ConfigurationError(message);

    logger.error({ err: error, ...context }, 'Configuration validation failed');

    throw error;
}

export const env = {
    int: (
        key: string,
        fallback: number,
        opts: {
            positive?: boolean;
            nonNegative?: boolean;
            fallbackKey?: string;
        } = {},
    ): number => {
        const primary = getEnv(key);
        const legacy = primary === undefined && opts.fallbackKey ? getEnv(opts.fallbackKey) : undefined;

        if (legacy !== undefined && opts.fallbackKey !== undefined) {
            logger.warn(
                { key, fallbackKey: opts.fallbackKey },
                'Deprecated configuration key is in use; switch to the primary key',
            );
        }

        const raw = primary ?? legacy;
        const value = raw === undefined ? fallback : parseStrictInt(raw, key);

        if (opts.positive) {
            assertPositiveInt(value, key);
        }

        if (opts.nonNegative) {
            assertNonNegativeInt(value, key);
        }

        return value;
    },

    str: (key: string, fallback: string): string => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        const trimmed = raw.trim();
        if (trimmed === '') {
            throwConfigError(`Invalid string value for ${key}: whitespace-only`, { key, type: 'string' });
        }
        return trimmed;
    },

    bool: (key: string, fallback = false): boolean => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        const lower = raw.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        throwConfigError(`Invalid boolean value for ${key}: "${raw}"`, { key, type: 'boolean' });
    },
};

export const parseStatusCodes = (envVar: string, fallback: Iterable<number>): Set<number> => {
    const raw = getEnv(envVar);
    if (raw === undefined) return new Set(fallback);

    const codes = raw.split(',').map((entry, i) => {
        const trimmed = entry.trim();
        if (trimmed === '') {
            throwConfigError(`Empty status code in ${envVar} at position ${i}`, { key: envVar, position: i });
        }
        if (!/^\d+$/.test(trimmed)) {
            throwConfigError(`Invalid status code in ${envVar}: "${trimmed}"`, { key: envVar, position: i });
        }
        const parsed = Number(trimmed);
        if (!isInteger(parsed) || parsed < 100 || parsed > 599) {
            throwConfigError(`Invalid status code in ${envVar}: "${trimmed}"`, { key: envVar, position: i });
        }
        return parsed;
    });

    return new Set(codes);
};

export interface ConfigValidationOptions {
    apiBaseUrl: string;
    apiDetailUrl: string;
}

export function validateConfig({ apiBaseUrl, apiDetailUrl }: ConfigValidationOptions): void {
    const requiredUrls: ReadonlyArray<readonly [string, string]> = [
        ['API_BASE_URL', apiBaseUrl],
        ['API_DETAIL_URL', apiDetailUrl],
    ];

    for (const [name, value] of requiredUrls) {
        if (value.trim() === '') {
            throwConfigError(`Missing required config: ${name}`, { key: name });
        }

        try {
            new URL(value);
        } catch {
            throwConfigError(`Invalid URL for ${name}: "${value}"`, { key: name, type: 'url' });
        }
    }
}
