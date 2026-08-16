import { env, parseStatusCodes, validateConfig } from './configValidation.js';
import { defaults } from './defaults.js';

export const LOG_LEVEL = env.str('LOG_LEVEL', defaults.LOG_LEVEL);
export const LOG_TO_FILE = env.str('LOG_TO_FILE', defaults.LOG_TO_FILE);
export const NODE_ENV = env.str('NODE_ENV', defaults.NODE_ENV);

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------
export const API_BASE_URL = env.str('API_BASE_URL', defaults.API_BASE_URL);
export const API_DETAIL_URL = env.str('API_DETAIL_URL', defaults.API_DETAIL_URL);
export const PAGE_SIZE = env.int('PAGE_SIZE', defaults.PAGE_SIZE, { positive: true });

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
export const CONCURRENCY = env.int('CONCURRENCY', defaults.CONCURRENCY, { positive: true });
export const FETCH_TIMEOUT_MS = env.int('FETCH_TIMEOUT_MS', defaults.FETCH_TIMEOUT_MS, { positive: true });
export const RETRY_BASE_DELAY_MS = env.int('RETRY_BASE_DELAY_MS', defaults.RETRY_BASE_DELAY_MS, { positive: true });
export const MAX_RETRIES = env.int('MAX_RETRIES', defaults.MAX_RETRIES, { nonNegative: true });
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = Object.freeze(
    parseStatusCodes('RETRYABLE_STATUS_CODES', defaults.RETRYABLE_STATUS_CODES),
);
export const BACKOFF_CAP_MS = env.int('BACKOFF_CAP_MS', defaults.BACKOFF_CAP_MS, { positive: true });
export const DEFAULT_USER_AGENT = env.str('DEFAULT_USER_AGENT', defaults.DEFAULT_USER_AGENT);
export const RETRY_ON_TIMEOUT = env.bool('RETRY_ON_TIMEOUT', defaults.RETRY_ON_TIMEOUT);
export const RETRY_ON_NETWORK_ERROR = env.bool('RETRY_ON_NETWORK_ERROR', defaults.RETRY_ON_NETWORK_ERROR);

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------
export const PROXY_URLS = env.str('PROXY_URLS', defaults.PROXY_URLS);
export const PROXY_POOL_CONNECTIONS = env.int('PROXY_POOL_CONNECTIONS', defaults.PROXY_POOL_CONNECTIONS, {
    positive: true,
});
export const MAX_POOL_CONNECTIONS = env.int('MAX_POOL_CONNECTIONS', defaults.MAX_POOL_CONNECTIONS, { positive: true });
export const PROXY_POOL_PIPELINING = env.int('PROXY_POOL_PIPELINING', defaults.PROXY_POOL_PIPELINING, {
    positive: true,
});
export const PROXY_POOL_KEEP_ALIVE_TIMEOUT = env.int(
    'PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS',
    defaults.PROXY_POOL_KEEP_ALIVE_TIMEOUT,
    { positive: true },
);
export const PROXY_POOL_HEADERS_TIMEOUT = env.int(
    'PROXY_POOL_HEADERS_TIMEOUT_MS',
    defaults.PROXY_POOL_HEADERS_TIMEOUT,
    {
        positive: true,
    },
);
export const PROXY_POOL_BODY_TIMEOUT = env.int('PROXY_POOL_BODY_TIMEOUT_MS', defaults.PROXY_POOL_BODY_TIMEOUT, {
    positive: true,
});
export const PROXY_POOL_CONNECT_TIMEOUT = env.int(
    'PROXY_POOL_CONNECT_TIMEOUT_MS',
    defaults.PROXY_POOL_CONNECT_TIMEOUT,
    {
        positive: true,
    },
);

export const PROXY_POOL_CONFIG: ProxyPoolConfig = Object.freeze({
    connections: PROXY_POOL_CONNECTIONS,
    maxConnections: MAX_POOL_CONNECTIONS,
    pipelining: PROXY_POOL_PIPELINING,
    keepAliveTimeout: PROXY_POOL_KEEP_ALIVE_TIMEOUT,
    headersTimeout: PROXY_POOL_HEADERS_TIMEOUT,
    bodyTimeout: PROXY_POOL_BODY_TIMEOUT,
    connectTimeout: PROXY_POOL_CONNECT_TIMEOUT,
});

export interface ProxyPoolConfig {
    readonly connections: number;
    readonly maxConnections: number;
    readonly connectTimeout: number;
    readonly pipelining: number;
    readonly keepAliveTimeout: number;
    readonly headersTimeout: number;
    readonly bodyTimeout: number;
}

// ---------------------------------------------------------------------------
// rateLimit
// ---------------------------------------------------------------------------
export const RATE_LIMIT_CAPACITY = env.int('RATE_LIMIT_CAPACITY', defaults.RATE_LIMIT_CAPACITY, {
    positive: true,
});
export const RATE_LIMIT_WINDOW = env.int('RATE_LIMIT_WINDOW', defaults.RATE_LIMIT_WINDOW, {
    positive: true,
});
export const ACQUIRE_TIMEOUT = env.int('ACQUIRE_TIMEOUT', defaults.ACQUIRE_TIMEOUT, {
    positive: true,
});

// ---------------------------------------------------------------------------
// Validate required fields
// ---------------------------------------------------------------------------
validateConfig({ apiBaseUrl: API_BASE_URL, apiDetailUrl: API_DETAIL_URL });
