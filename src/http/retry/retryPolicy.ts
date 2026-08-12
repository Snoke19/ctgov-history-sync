import {
    BACKOFF_CAP_MS,
    RETRY_BASE_DELAY_MS,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../../config/config.js';
import { HttpException, NetworkException, TimeoutException, TrialError } from '../../error/errors.js';
import { HttpResponse } from '../endpoint/transport/httpTransport.js';
import { defaultRandom } from '../types/clock.js';

/**
 * Configurable retry policy. All fields are plain values, so the object
 * can be constructed ad-hoc in tests without touching module-level state.
 */
export interface RetryPolicyConfig {
    readonly retryOnTimeout: boolean;
    readonly retryOnNetworkError: boolean;
    readonly retryableStatusCodes: ReadonlySet<number>;

    /**
     * Base delay (ms) seeded into the first exponential-backoff retry.
     * When omitted the configured RETRY_BASE_DELAY_MS value is used.
     */
    readonly baseDelayMs?: number;

    /**
     * Upper bound (ms) applied to any single retry delay, including
     * Retry-After. When omitted the configured BACKOFF_CAP_MS value is used.
     */
    readonly backoffCapMs?: number;
}

/**
 * Default policy derived from environment / module-level config.
 * Used when the caller does not provide an explicit policy.
 */
export const defaultRetryPolicyConfig: RetryPolicyConfig = {
    retryOnTimeout: RETRY_ON_TIMEOUT,
    retryOnNetworkError: RETRY_ON_NETWORK_ERROR,
    retryableStatusCodes: RETRYABLE_STATUS_CODES,
    baseDelayMs: RETRY_BASE_DELAY_MS,
    backoffCapMs: BACKOFF_CAP_MS,
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
 * Delay parameters for {@link calculateBackoff}.
 *
 * Each field is optional and defaults to the configured value, so callers
 * that only care about the default behaviour can pass `{}` (or nothing) while
 * tests inject explicit numbers to stay decoupled from module-level config.
 */
export interface BackoffOptions {
    /** Jitter source returning a value in [0, 1)]. Defaults to the shared HTTP-layer source. */
    readonly random?: () => number;

    /** Base delay (ms) for the first retry. Defaults to RETRY_BASE_DELAY_MS. */
    readonly baseDelayMs?: number;

    /** Maximum delay (ms). Defaults to BACKOFF_CAP_MS. */
    readonly backoffCapMs?: number;
}

/**
 * Calculates the delay before the next retry attempt.
 *
 * Priority:
 *   1. Server-supplied Retry-After value (exact, in ms), capped at `backoffCapMs`.
 *   2. Exponential backoff: base × 2^attempt, plus up to 50% random jitter.
 *   3. Capped at `backoffCapMs`.
 *
 * Jitter prevents thundering-herd conditions when many requests fail
 * simultaneously and would otherwise all retry at the same instant.
 *
 * @param attempt      - Zero-indexed retry number (0 = first retry).
 * @param retryAfterMs - Parsed Retry-After header value in ms, or null.
 * @param options      - Optional base/cap/jitter overrides.
 */
export function calculateBackoff(attempt: number, retryAfterMs: number | null, options: BackoffOptions = {}): number {
    const { random = defaultRandom.random, baseDelayMs = RETRY_BASE_DELAY_MS, backoffCapMs = BACKOFF_CAP_MS } = options;

    if (retryAfterMs !== null && retryAfterMs > 0) return Math.min(retryAfterMs, backoffCapMs);

    const base = baseDelayMs * 2 ** attempt;
    const jitter = random() * base * 0.5;
    return Math.min(base + jitter, backoffCapMs);
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
 *
 * Note on 408/429 + POST: 408 (Request Timeout) and 429 (Too Many Requests)
 * are retried for non-idempotent methods by design. 408 signals the server
 * did not receive the full request; 429 signals rate-limiting — neither
 * implies the server processed the side effect. If a specific POST endpoint
 * is known to be unsafe to retry, the caller should pass idempotent: false
 * or remove 408/429 from retryableStatusCodes.
 */
export function shouldRetry(
    error: TrialError,
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
