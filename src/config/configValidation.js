const isInteger = (n) => Number.isFinite(n) && Number.isInteger(n);

const parseStrictInt = (raw, key) => {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
        throw new Error(`Invalid integer value for ${key}: "${raw}"`);
    }
    const parsed = Number(trimmed);
    if (!isInteger(parsed)) {
        throw new Error(`Invalid integer value for ${key}: "${raw}"`);
    }
    return parsed;
};

const getEnv = (key) => {
    const value = process.env[key];
    return value === undefined || value === '' ? undefined : value;
};

export const env = {
    int: (key, fallback) => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        return parseStrictInt(raw, key);
    },

    str: (key, fallback) => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        const trimmed = raw.trim();
        if (trimmed === '') {
            throw new Error(`Invalid string value for ${key}: whitespace-only`);
        }
        return trimmed;
    },

    bool: (key, fallback = false) => {
        const raw = getEnv(key);
        if (raw === undefined) return fallback;
        const lower = raw.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        throw new Error(`Invalid boolean value for ${key}: "${raw}"`);
    }
};

export const parseStatusCodes = (envVar, fallback) => {
    const raw = process.env[envVar];
    if (raw === undefined || raw === '') return new Set(fallback);

    const codes = raw.split(',').map((s, i) => {
        const trimmed = s.trim();
        if (trimmed === '') {
            throw new Error(`Empty status code in ${envVar} at position ${i}`);
        }
        if (!/^\d+$/.test(trimmed)) {
            throw new Error(`Invalid status code in ${envVar}: "${trimmed}"`);
        }
        const parsed = Number(trimmed);
        if (!isInteger(parsed) || parsed < 100 || parsed > 599) {
            throw new Error(`Invalid status code in ${envVar}: "${trimmed}"`);
        }
        return parsed;
    });

    return new Set(codes);
};

export function validateConfig({apiBaseUrl, apiDetailUrl}) {
    const requiredUrls = [
        ['API_BASE_URL', apiBaseUrl],
        ['API_DETAIL_URL', apiDetailUrl],
    ];

    for (const [name, value] of requiredUrls) {
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(`Missing required config: ${name}`);
        }

        try {
            new URL(value);
        } catch {
            throw new Error(`Invalid URL for ${name}: "${value}"`);
        }
    }
}