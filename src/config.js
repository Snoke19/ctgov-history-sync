// Public v2 REST API
export const API_BASE_URL = process.env.API_BASE_URL;

// Internal detail endpoint (used for history=true per-trial fetch)
export const API_DETAIL_URL = process.env.API_DETAIL_URL;

// Number of concurrent in-flight requests. Start low; bump if 429s are rare.
export const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);

// Items per list-API page. Max the server allows is 1000.
export const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 100);

// Timeout per individual HTTP request (ms).
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 10000);

// Fallback wait when the API returns 429 without a Retry-After header (ms).
export const DEFAULT_RETRY_AFTER_MS = Number(process.env.DEFAULT_RETRY_AFTER_MS ?? 1000);

// Progress log interval (ms).
export const PROGRESS_INTERVAL_MS = Number(process.env.PROGRESS_INTERVAL_MS ?? 10000);
