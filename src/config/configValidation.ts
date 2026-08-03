import {ConfigurationError} from '../error/errors.js';
import {assertPositiveInt} from '../utils/validation.js';

const isInteger = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n);

const parseStrictInt = (raw: string, key: string): number => {
    const trimmed = raw.trim();

    if (!/^-?\d+$/.test(trimmed)) {
        throw new ConfigurationError(`Invalid integer value for ${key}: "${raw}"`);
    }

    const parsed = Number(trimmed);

    if (!isInteger(parsed)) {
        throw new ConfigurationError(`Invalid integer value for ${key}: "${raw}"`);
    }

    return parsed;
};

const getEnv = (key: string): string | undefined => {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : value;
};

export const env = {
    int: (key: string, fallback: number, opts: { positive?: boolean } = {}): number => {
        const raw = getEnv(key);
        const value = raw === undefined ? fallback : parseStrictInt(raw, key);
        if (opts.positive) assertPositiveInt(value, key);
        return value;
    },

    str: (key: string, fallback: string): string => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        const trimmed = raw.trim();
        if (trimmed === '') {
            throw new ConfigurationError(`Invalid string value for ${key}: whitespace-only`);
        }
        return trimmed;
    },

    bool: (key: string, fallback = false): boolean => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        const lower = raw.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        throw new ConfigurationError(`Invalid boolean value for ${key}: "${raw}"`);
    },
};

export const parseStatusCodes = (envVar: string, fallback: Iterable<number>): Set<number> => {
    const raw = getEnv(envVar);
    if (raw === undefined) return new Set(fallback);

    const codes = raw.split(',').map((entry, i) => {
        const trimmed = entry.trim();
        if (trimmed === '') {
            throw new ConfigurationError(`Empty status code in ${envVar} at position ${i}`);
        }
        if (!/^\d+$/.test(trimmed)) {
            throw new ConfigurationError(`Invalid status code in ${envVar}: "${trimmed}"`);
        }
        const parsed = Number(trimmed);
        if (!isInteger(parsed) || parsed < 100 || parsed > 599) {
            throw new ConfigurationError(`Invalid status code in ${envVar}: "${trimmed}"`);
        }
        return parsed;
    });

    return new Set(codes);
};

export interface ConfigValidationOptions {
    apiBaseUrl: string;
    apiDetailUrl: string;
}

export function validateConfig({apiBaseUrl, apiDetailUrl}: ConfigValidationOptions): void {
    const requiredUrls: ReadonlyArray<readonly [string, string]> = [
        ['API_BASE_URL', apiBaseUrl],
        ['API_DETAIL_URL', apiDetailUrl],
    ];

    for (const [name, value] of requiredUrls) {
        if (value.trim() === '') {
            throw new ConfigurationError(`Missing required config: ${name}`);
        }

        try {
            new URL(value);
        } catch {
            throw new ConfigurationError(`Invalid URL for ${name}: "${value}"`);
        }
    }
}