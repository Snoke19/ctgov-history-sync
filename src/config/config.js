const env = {
    int: (key, fallback) => {
        const val = process.env[key];
        return val ? parseInt(val, 10) : fallback;
    },
    str: (key, fallback) => process.env[key] || fallback,
};

export const API_BASE_URL = env.str('API_BASE_URL', '');
export const API_DETAIL_URL = env.str('API_DETAIL_URL', '');
export const CONCURRENCY = env.int('CONCURRENCY', 10);
export const PAGE_SIZE = env.int('PAGE_SIZE', 1000);
export const FETCH_TIMEOUT_MS = env.int('FETCH_TIMEOUT_MS', 15000);
export const DEFAULT_RETRY_AFTER_MS = env.int('DEFAULT_RETRY_AFTER_MS', 5000);
export const RETRY_BASE_DELAY_MS = env.int('RETRY_BASE_DELAY_MS', 1000);
export const MAX_RETRIES = env.int('MAX_RETRIES', 3);

export const raw = env.str('PROXY_IP', '');
export const POOL_CONNECTIONS = env.int('PROXY_POOL_CONNECTIONS', 10);
export const POOL_PIPELINING = env.int('PROXY_POOL_PIPELINING', 1);
export const POOL_KEEP_ALIVE_TIMEOUT = env.int('PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS', 300_000);
export const POOL_HEADERS_TIMEOUT = env.int('PROXY_POOL_HEADERS_TIMEOUT_MS', 15_000);
export const POOL_BODY_TIMEOUT = env.int('PROXY_POOL_BODY_TIMEOUT_MS', 45_000);

export const RATE_LIMIT_CAPACITY = env.int('PROXY_RATE_LIMIT_CAPACITY', 40);
export const RATE_LIMIT_WINDOW = env.int('PROXY_RATE_LIMIT_WINDOW_MS', 60_000);

export const ACQUIRE_TIMEOUT = env.int('PROXY_ACQUIRE_TIMEOUT_MS', 30_000);
export const ACQUIRE_TIER = env.int('PROXY_ACQUIRE_TIER_SIZE', 3);
