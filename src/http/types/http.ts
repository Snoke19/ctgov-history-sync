import { ProxyPoolConfig } from '../../config/config.js';
import { RetryPolicyConfig } from '../retry/retryPolicy.js';
import type { MonotonicClock, RandomSource, Sleeper, WallClock } from './clock.js';

export type QueryParamValue = string | number | boolean;

/**
 * Query parameters support scalar values and string arrays.
 *
 * Arrays are encoded as repeated query parameters:
 * `['a', 'b']` -> `?key=a&key=b`.
 */
export type QueryParamInput = QueryParamValue | string[] | null | undefined;

export interface QueryParams {
    readonly [key: string]: QueryParamInput;
}

export interface HttpClientOptions {
    readonly proxyUrls?: string;
    readonly useRateLimit?: boolean;
    readonly rateLimitCapacity: number;
    readonly rateLimitWindow: number;
    readonly acquireTimeout: number;
    readonly concurrency: number;
    readonly poolConfig?: Readonly<ProxyPoolConfig>;

    /** Override real sleep (e.g. fake timers in tests). Defaults to setTimeout. */
    sleep?: Sleeper['sleep'];

    /** Override Math.random (e.g. deterministic backoff in tests). */
    random?: RandomSource['random'];

    /** Wall-clock source used for HTTP-date calculations such as Retry-After. */
    wallClock?: WallClock;

    /** Monotonic clock used for elapsed-duration calculations. */
    monotonicClock?: MonotonicClock;
}

/**
 * Options for a single fetchJson call.
 * All fields are optional; defaults are applied at call-time from config.
 */
export interface FetchJsonRequestOptions {
    headers?: Record<string, string>;

    /**
     * Maximum duration of a single HTTP attempt in milliseconds.
     * Each retry attempt receives a fresh timeout.
     * Defaults to FETCH_TIMEOUT_MS.
     */
    timeoutMs?: number;

    /**
     * Maximum number of retries after the initial attempt.
     *
     * For example, maxRetries: 2 allows up to 3 total requests
     * (1 initial + 2 retries). A value of 0 means no retries at all.
     *
     * Defaults to MAX_RETRIES from config.
     */
    maxRetries?: number;

    /**
     * When true, a 404 response resolves to null rather than throwing.
     */
    allow404?: boolean;

    /** Caller-controlled cancellation signal. */
    signal?: AbortSignal;

    retryPolicy?: Partial<RetryPolicyConfig>;
}
