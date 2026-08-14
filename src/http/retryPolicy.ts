import {
    BACKOFF_CAP_MS,
    RETRY_BASE_DELAY_MS,
    RETRY_ON_NETWORK_ERROR,
    RETRY_ON_TIMEOUT,
    RETRYABLE_STATUS_CODES,
} from '../config/config.js';
import { HttpException, NetworkException, TimeoutException, TrialError } from '../error/errors.js';
import { defaultRandom } from './clock.js';
import { HttpResponse } from './transport/httpTransport.js';

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
 * Delay parameters for {@link calculateBackoff}.
 *
 * Each field is optional and defaults to the configured value, so callers
 * that only care about the default behavior can pass `{}` (or nothing) while
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

    if (retryAfterMs !== null && retryAfterMs > 0) {
        return Math.min(retryAfterMs, backoffCapMs);
    }

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
export function parseRetryAfterHeader(response: HttpResponse, now: number = Date.now()): number | null {
    const raw = response.headers.get('Retry-After');
    if (!raw) return null;

    const value = raw.trim();

    if (/^[+-]?\d/.test(value)) {
        if (!/^\d+$/.test(value)) {
            return null;
        }

        const seconds = Number(value);

        if (!Number.isSafeInteger(seconds)) {
            return null;
        }

        return seconds * 1000;
    }

    const dateMs = Date.parse(value);

    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - now);
    }

    return null;
}

/**
 * Decides whether a failed GET request should be retried.
 *
 * - Timeouts        → retried only when config.retryOnTimeout is true.
 * - Network errors  → retried only when config.retryOnNetworkError is true.
 * - HTTP errors     → retried only when the status is in
 *                     config.retryableStatusCodes.
 */
export function shouldRetry(error: TrialError, config: RetryPolicyConfig): boolean {
    if (error instanceof TimeoutException) {
        return config.retryOnTimeout;
    }

    if (error instanceof NetworkException) {
        return config.retryOnNetworkError;
    }

    if (error instanceof HttpException) {
        return config.retryableStatusCodes.has(error.status);
    }

    return false;
}
