const isInteger = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n);

const parseStrictInt = (raw: string, key: string): number => {
    const trimmed: string = raw.trim();

    if (!/^-?\d+$/.test(trimmed)) {
        throw new Error(`Invalid integer value for ${key}: "${raw}"`);
    }

    const parsed: number = Number(trimmed);

    if (!isInteger(parsed)) {
        throw new Error(`Invalid integer value for ${key}: "${raw}"`);
    }

    return parsed;
};

const getEnv = (key: string): string | undefined => {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : value;
};

export const env = {
    int: (key: string, fallback: number): number => {
        const raw: string | undefined = getEnv(key);
        if (raw === undefined) return fallback;
        return parseStrictInt(raw, key);
    },

    str: (key: string, fallback: string): string => {
        const raw: string | undefined = getEnv(key);
        if (raw === undefined) return fallback;
        const trimmed: string = raw.trim();
        if (trimmed === '') {
            throw new Error(`Invalid string value for ${key}: whitespace-only`);
        }
        return trimmed;
    },

    bool: (key: string, fallback: boolean = false): boolean => {
        const raw: string | undefined = getEnv(key);
        if (raw === undefined) return fallback;
        const lower: string = raw.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        throw new Error(`Invalid boolean value for ${key}: "${raw}"`);
    }
};

export const parseStatusCodes = (envVar: string, fallback: Iterable<number>): Set<number> => {
    const raw: string | undefined = process.env[envVar];
    if (raw === undefined || raw === '') return new Set(fallback);

    const codes: number[] = raw.split(',').map((s, i): number => {
        const trimmed: string = s.trim();
        if (trimmed === '') {
            throw new Error(`Empty status code in ${envVar} at position ${i}`);
        }
        if (!/^\d+$/.test(trimmed)) {
            throw new Error(`Invalid status code in ${envVar}: "${trimmed}"`);
        }
        const parsed: number = Number(trimmed);
        if (!isInteger(parsed) || parsed < 100 || parsed > 599) {
            throw new Error(`Invalid status code in ${envVar}: "${trimmed}"`);
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
            throw new Error(`Missing required config: ${name}`);
        }

        try {
            new URL(value);
        } catch {
            throw new Error(`Invalid URL for ${name}: "${value}"`);
        }
    }
}