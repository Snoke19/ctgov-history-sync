import {
    BACKOFF_CAP_MS,
    RETRY_BASE_DELAY_MS,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../../config/config.js';
import { HttpResponse } from '../endpoint/transport/httpTransport.js';
import { BusinessException } from './businessException.js';
import { HttpException, NetworkException, TimeoutException } from './exceptions.js';

/**
 * Configurable retry policy. All fields are plain values, so the object
 * can be constructed ad-hoc in tests without touching module-level state.
 */
export interface RetryPolicyConfig {
    readonly retryOnTimeout: boolean;
    readonly retryOnNetworkError: boolean;
    readonly retryableStatusCodes: ReadonlySet<number>;
}

/**
 * Default policy derived from environment / module-level config.
 * Used when the caller does not provide an explicit policy.
 */
export const defaultRetryPolicyConfig: RetryPolicyConfig = {
    retryOnTimeout: RETRY_ON_TIMEOUT,
    retryOnNetworkError: RETRY_ON_NETWORK_ERROR,
    retryableStatusCodes: RETRYABLE_STATUS_CODES,
};

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
 *   1. Server-supplied Retry-After value (exact, in ms), capped at BACKOFF_CAP_MS.
 *   2. Exponential backoff: base × 2^attempt, plus up to 50% random jitter.
 *   3. Capped at BACKOFF_CAP_MS.
 *
 * Jitter prevents thundering-herd conditions when many requests fail
 * simultaneously and would otherwise all retry at the same instant.
 *
 * @param attempt      - Zero-indexed retry number (0 = first retry).
 * @param retryAfterMs - Parsed Retry-After header value in ms, or null.
 */
export function calculateBackoff(
    attempt: number,
    retryAfterMs: number | null,
    random: () => number = Math.random,
): number {
    if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(retryAfterMs, BACKOFF_CAP_MS);

    const base = RETRY_BASE_DELAY_MS * 2 ** attempt;
    const jitter = random() * base * 0.5;
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

/**
 * Decides whether a given error warrants another attempt.
 *
 * - Timeouts        → retried only when config.retryOnTimeout is true.
 * - Network errors  → retried only when config.retryOnNetworkError is true.
 * - HTTP errors     → retried only if the status is in config.retryableStatusCodes;
 *                     5xx additionally requires the request to be idempotent.
 */
export function shouldRetry(
    error: BusinessException,
    method: string,
    config: RetryPolicyConfig,
    idempotent?: boolean,
): boolean {
    if (error instanceof TimeoutException) return config.retryOnTimeout;
    if (error instanceof NetworkException) return config.retryOnNetworkError;

    if (error instanceof HttpException) {
        if (!config.retryableStatusCodes.has(error.status)) return false;
        if (error.status >= 500) return isIdempotent(method, idempotent);
        return true;
    }

    return false;
}
