import { BACKOFF_CAP_MS, RETRY_BASE_DELAY_MS } from '../../config/config.js';
import { HttpResponse } from '../endpoint/transport/httpTransport.js';

/**
 * HTTP methods that are idempotent by definition.
 *
 * GET, HEAD, PUT, DELETE, and OPTIONS carry no risk of duplicate side effects
 * when repeated. POST and PATCH are excluded — pass idempotent: true to a
 * specific call if you know the endpoint is safe to repeat (e.g. an upsert).
 */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

/**
 * Returns whether a request is safe to retry.
 *
 * @param method   - HTTP method, e.g. 'GET'.
 * @param override - When provided, takes precedence over the method-based check.
 */
export function isIdempotent(method: string, override?: boolean): boolean {
    if (override !== undefined) return override;
    return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Calculates the delay before the next retry attempt.
 *
 * Priority:
 *   1. Server-supplied Retry-After value (exact, in ms).
 *   2. Exponential backoff: base × 2^attempt, plus up to 50% random jitter.
 *   3. Capped at BACKOFF_CAP_MS.
 *
 * Jitter prevents thundering-herd conditions when many requests fail
 * simultaneously and would otherwise all retry at the same instant.
 *
 * @param attempt      - Zero-indexed retry number (0 = first retry).
 * @param retryAfterMs - Parsed Retry-After header value in ms, or null.
 */
export function calculateBackoff(attempt: number, retryAfterMs: number | null): number {
    if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;

    const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
    const jitter = Math.random() * base * 0.5;
    return Math.min(base + jitter, BACKOFF_CAP_MS);
}

/**
 * Parses the Retry-After response header into milliseconds.
 *
 * Supports both forms defined by RFC 9110:
 *   - Delay-seconds:  `Retry-After: 120`
 *   - HTTP-date:      `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 *
 * @returns Milliseconds to wait, or null if the header is absent.
 *          Returns 0 if the parsed date is already in the past.
 */
export function parseRetryAfterHeader(response: HttpResponse): number | null {
    const raw = response.headers.get('Retry-After');
    if (!raw) return null;

    const seconds = Number(raw);
    if (!Number.isNaN(seconds)) return seconds * 1000;

    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());

    return null;
}
