import {env, parseStatusCodes} from "./configValidation.js";

export const API_BASE_URL = env.str('API_BASE_URL', '');
export const API_DETAIL_URL = env.str('API_DETAIL_URL', '');
export const CONCURRENCY = env.int('CONCURRENCY', 10);
export const PAGE_SIZE = env.int('PAGE_SIZE', 10);
export const FETCH_TIMEOUT_MS = env.int('FETCH_TIMEOUT_MS', 15000);
export const DEFAULT_RETRY_AFTER_MS = env.int('DEFAULT_RETRY_AFTER_MS', 5000);
export const RETRY_BASE_DELAY_MS = env.int('RETRY_BASE_DELAY_MS', 1000);
export const MAX_RETRIES = env.int('MAX_RETRIES', 3);
export const RETRYABLE_STATUS_CODES = parseStatusCodes(
    'RETRYABLE_STATUS_CODES',
    [408, 429, 500, 502, 503, 504],
);
export const BACKOFF_CAP_MS = env.int('BACKOFF_CAP_MS', 30_000);
export const DEFAULT_USER_AGENT = env.str('DEFAULT_USER_AGENT', 'ClinicalTrialsScraper/1.0');
export const ERROR_BODY_PREVIEW_LENGTH = env.int('ERROR_BODY_PREVIEW_LENGTH', 200);
export const RETRY_AFTER_STATUS_CODES = parseStatusCodes('RETRY_AFTER_STATUS_CODES', [429]);
export const RETRY_ON_TIMEOUT = env.bool('RETRY_ON_TIMEOUT', true);
export const RETRY_ON_NETWORK_ERROR = env.bool('RETRY_ON_NETWORK_ERROR', true);

export const PROXY_IPS = env.str('PROXY_IP', '');
export const POOL_CONNECTIONS = env.int('PROXY_POOL_CONNECTIONS', 10);
export const POOL_PIPELINING = env.int('PROXY_POOL_PIPELINING', 1);
export const POOL_KEEP_ALIVE_TIMEOUT = env.int('PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS', 300_000);
export const POOL_HEADERS_TIMEOUT = env.int('PROXY_POOL_HEADERS_TIMEOUT_MS', 15_000);
export const POOL_BODY_TIMEOUT = env.int('PROXY_POOL_BODY_TIMEOUT_MS', 45_000);

export const RATE_LIMIT_CAPACITY = env.int('PROXY_RATE_LIMIT_CAPACITY', 40);
export const RATE_LIMIT_WINDOW = env.int('PROXY_RATE_LIMIT_WINDOW_MS', 60_000);

export const ACQUIRE_TIMEOUT = env.int('PROXY_ACQUIRE_TIMEOUT_MS', 30_000);
