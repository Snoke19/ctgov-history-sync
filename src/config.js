// Public v2 REST API — cursor-based pagination, pageSize up to 1000, no offset cap
export const API_BASE_URL = process.env.API_BASE_URL;

// Detail endpoint — same v2 base, single study by NCT ID
export const API_DETAIL_URL = process.env.API_DETAIL_URL;

// Concurrent in-flight detail requests. Keep low to avoid 429s.
export const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);

// Studies per list-API page. Server max is 1000.
export const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 100);

// Per-request timeout in ms.
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 10_000);

// Fallback wait when a 429 arrives without a Retry-After header.
export const DEFAULT_RETRY_AFTER_MS = Number(process.env.DEFAULT_RETRY_AFTER_MS ?? 1_000);

// Base delay for exponential backoff (ms).
export const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS ?? 1_000);

// Total retry attempts AFTER the first failure (e.g. 3 → up to 4 total attempts).
export const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 3);
