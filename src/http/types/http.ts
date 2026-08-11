import { ProxyPoolConfig } from '../../config/config.js';
import { RetryPolicyConfig } from '../retry/retryPolicy.js';
export type QueryParamValue = string | number | boolean;
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
}

/**
 * Options for a single fetchJson call.
 * All fields are optional; defaults are applied at call-time from config
 * or inferred from the HTTP method.
 */
export interface FetchJsonRequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;

    /**
     * Per-request timeout in milliseconds.
     * Defaults to FETCH_TIMEOUT_MS from config.
     */
    timeoutMs?: number;

    /**
     * Absolute deadline (epoch ms). When provided, the remaining budget is
     * forwarded to endpoint acquisition on each attempt so all retries share
     * one global time budget rather than getting a fresh window each time.
     */
    deadline?: number;

    /**
     * Maximum retry attempts (not counting the initial try).
     * Defaults to MAX_RETRIES from config.
     */
    maxRetries?: number;

    /**
     * Overrides the built-in idempotency check for retry decisions.
     * When omitted, idempotency is inferred from the HTTP method:
     * GET, HEAD, PUT, DELETE, and OPTIONS are safe to retry automatically;
     * POST and PATCH are not unless this is explicitly set to true.
     */
    idempotent?: boolean;

    /**
     * When true, a 404 response resolves to null rather than throwing.
     */
    allow404?: boolean;

    /** Caller-controlled cancellation signal. */
    signal?: AbortSignal;

    retryPolicy?: Partial<RetryPolicyConfig>;
}
