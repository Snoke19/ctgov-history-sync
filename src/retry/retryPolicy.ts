import {
    CallerAbortedError,
    ConfigurationError,
    HttpException,
    NetworkException,
    TimeoutException,
    TrialError,
} from '../error/errors.js';
import { HttpResponse } from '../http/transport/httpTransport.js';
import { makeAssertions } from '../utils/assertions.js';

const retryPolicyAssert = makeAssertions(ConfigurationError);
const JITTER_FACTOR = 0.5;

/**
 * Configurable retry policy. All fields are plain values, so the object
 * can be constructed ad-hoc in tests without touching module-level state.
 */
export interface RetryPolicyConfig {
    readonly retryOnTimeout: boolean;
    readonly retryOnNetworkError: boolean;
    readonly retryableStatusCodes: ReadonlySet<number>;
    readonly baseDelayMs: number;
    readonly backoffCapMs: number;
}

/**
 * Parameters used by {@link calculateBackoff}.
 *
 * All values are supplied explicitly by the caller so the retry calculation
 * remains independent of application-level configuration.
 */
export interface BackoffOptions {
    readonly random: () => number;
    readonly baseDelayMs: number;
    readonly backoffCapMs: number;
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
 * @param options      - Backoff parameters used for this calculation.
 */
export function calculateBackoff(attempt: number, retryAfterMs: number | null, options: BackoffOptions): number {
    if (retryAfterMs !== null && retryAfterMs >= 0) {
        return Math.min(retryAfterMs, options.backoffCapMs);
    }

    const baseDelay = calculateExponentialBase(attempt, options.baseDelayMs);
    if (!Number.isFinite(baseDelay)) {
        return options.backoffCapMs;
    }

    const jitter = calculateJitter(baseDelay, options.random);
    return Math.min(baseDelay + jitter, options.backoffCapMs);
}

/**
 * Parses the Retry-After response header into milliseconds.
 *
 * Supports both forms defined by RFC 9110:
 *   - Delay-seconds:  `Retry-After: 120`
 *   - HTTP-date:      `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 *
 * @returns Milliseconds to wait, or null if the header is absent or malformed.
 *          Returns 0 if the parsed date is already in the past.
 */
export function parseRetryAfterHeader(response: HttpResponse, now: number = Date.now()): number | null {
    const raw = response.headers.get('Retry-After');
    if (!raw) {
        return null;
    }

    const value = raw.trim();

    if (/^[+-]?\d/.test(value)) {
        return tryParseDelaySeconds(value);
    }

    return tryParseHttpDate(value, now);
}

/**
 * Validates a retry policy config before it is used.
 *
 * Throws ConfigurationError on the first violation.
 */
export function validateRetryPolicyConfig(config: RetryPolicyConfig): void {
    assert404NotRetryable(config);
    assertBackoffOrdering(config);
    assertValidStatusCodes(config);
    assertPositiveInteger(config.baseDelayMs, 'baseDelayMs');
    assertPositiveInteger(config.backoffCapMs, 'backoffCapMs');
}

/**
 * Decides whether a failed GET request should be retried.
 *
 * - Caller-aborted errors are never retried.
 * - Timeouts        → retried only when config.retryOnTimeout is true.
 * - Network errors  → retried only when config.retryOnNetworkError is true.
 * - HTTP errors     → retried only when the status is in config.retryableStatusCodes.
 */
export function shouldRetry(error: TrialError, config: RetryPolicyConfig): boolean {
    if (error instanceof CallerAbortedError) {
        return false;
    }

    return isEligibleForRetry(error, config);
}

function calculateExponentialBase(attempt: number, baseDelayMs: number): number {
    return baseDelayMs * 2 ** attempt;
}

function calculateJitter(baseDelay: number, random: () => number): number {
    return random() * baseDelay * JITTER_FACTOR;
}

function tryParseDelaySeconds(value: string): number | null {
    // RFC 9110: delay-seconds is a non-negative decimal integer.
    if (!/^\d+$/.test(value)) {
        return null;
    }

    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) {
        return null;
    }

    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function tryParseHttpDate(value: string, now: number): number | null {
    const dateMs = Date.parse(value);
    if (Number.isNaN(dateMs)) {
        return null;
    }
    return Math.max(0, dateMs - now);
}

function assert404NotRetryable(config: RetryPolicyConfig): void {
    if (config.retryableStatusCodes.has(404)) {
        throw new ConfigurationError(
            '404 must not be in retryableStatusCodes. ' +
                'The allow404 option depends on 404 being non-retryable so that ' +
                'retry.perform() throws an HttpException instead of looping.',
        );
    }
}

function assertBackoffOrdering(config: RetryPolicyConfig): void {
    if (config.backoffCapMs < config.baseDelayMs) {
        throw new ConfigurationError('backoffCapMs must be >= baseDelayMs');
    }
}

function assertValidStatusCodes(config: RetryPolicyConfig): void {
    for (const status of config.retryableStatusCodes) {
        if (!Number.isInteger(status) || status < 100 || status > 599) {
            throw new ConfigurationError(`retryableStatusCodes contains invalid status: ${status}`);
        }
    }
}

function assertPositiveInteger(value: number, name: string): void {
    retryPolicyAssert.assertInteger(value, name, { min: 1, label: 'a positive integer' });
}

function isEligibleForRetry(error: TrialError, config: RetryPolicyConfig): boolean {
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
