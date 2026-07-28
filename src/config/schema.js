import {defaults} from './defaults.js';
import {env, parseStatusCodes, validateConfig} from './configValidation.js';

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------
export const API_BASE_URL = env.str('API_BASE_URL', defaults.API_BASE_URL);
export const API_DETAIL_URL = env.str('API_DETAIL_URL', defaults.API_DETAIL_URL);
export const PAGE_SIZE = env.int('PAGE_SIZE', defaults.PAGE_SIZE);

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------
export const CONCURRENCY = env.int('CONCURRENCY', defaults.CONCURRENCY);
export const FETCH_TIMEOUT_MS = env.int('FETCH_TIMEOUT_MS', defaults.FETCH_TIMEOUT_MS);
export const DEFAULT_RETRY_AFTER_MS = env.int('DEFAULT_RETRY_AFTER_MS', defaults.DEFAULT_RETRY_AFTER_MS);
export const RETRY_BASE_DELAY_MS = env.int('RETRY_BASE_DELAY_MS', defaults.RETRY_BASE_DELAY_MS);
export const MAX_RETRIES = env.int('MAX_RETRIES', defaults.MAX_RETRIES);
export const RETRYABLE_STATUS_CODES = parseStatusCodes('RETRYABLE_STATUS_CODES', defaults.RETRYABLE_STATUS_CODES);
export const RETRY_AFTER_STATUS_CODES = parseStatusCodes('RETRY_AFTER_STATUS_CODES', defaults.RETRY_AFTER_STATUS_CODES);
export const BACKOFF_CAP_MS = env.int('BACKOFF_CAP_MS', defaults.BACKOFF_CAP_MS);
export const DEFAULT_USER_AGENT = env.str('DEFAULT_USER_AGENT', defaults.DEFAULT_USER_AGENT);
export const ERROR_BODY_PREVIEW_LENGTH = env.int('ERROR_BODY_PREVIEW_LENGTH', defaults.ERROR_BODY_PREVIEW_LENGTH);
export const RETRY_ON_TIMEOUT = env.bool('RETRY_ON_TIMEOUT', defaults.RETRY_ON_TIMEOUT);
export const RETRY_ON_NETWORK_ERROR = env.bool('RETRY_ON_NETWORK_ERROR', defaults.RETRY_ON_NETWORK_ERROR);

// ---------------------------------------------------------------------------
// proxy
// ---------------------------------------------------------------------------
export const PROXY_IPS = env.str('PROXY_IPS', defaults.PROXY_IPS);
export const POOL_CONNECTIONS = env.int('PROXY_POOL_CONNECTIONS', defaults.POOL_CONNECTIONS);
export const POOL_PIPELINING = env.int('PROXY_POOL_PIPELINING', defaults.POOL_PIPELINING);
export const POOL_KEEP_ALIVE_TIMEOUT = env.int('PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS', defaults.POOL_KEEP_ALIVE_TIMEOUT);
export const POOL_HEADERS_TIMEOUT = env.int('PROXY_POOL_HEADERS_TIMEOUT_MS', defaults.POOL_HEADERS_TIMEOUT);
export const POOL_BODY_TIMEOUT = env.int('PROXY_POOL_BODY_TIMEOUT_MS', defaults.POOL_BODY_TIMEOUT);

// ---------------------------------------------------------------------------
// rateLimit
// ---------------------------------------------------------------------------
export const RATE_LIMIT_CAPACITY = env.int('PROXY_RATE_LIMIT_CAPACITY', defaults.RATE_LIMIT_CAPACITY);
export const RATE_LIMIT_WINDOW = env.int('PROXY_RATE_LIMIT_WINDOW_MS', defaults.RATE_LIMIT_WINDOW);
export const ACQUIRE_TIMEOUT = env.int('PROXY_ACQUIRE_TIMEOUT_MS', defaults.ACQUIRE_TIMEOUT);

// ---------------------------------------------------------------------------
// Validate required fields
// ---------------------------------------------------------------------------
validateConfig({apiBaseUrl: API_BASE_URL, apiDetailUrl: API_DETAIL_URL});