import { ProxyPoolConfig } from '../../../config/config.js';

/**
 * Transport-level error taxonomy. Each transport knows the error shapes of
 * its underlying library (WHATWG fetch/DOMException, axios, raw sockets,
 * node:http, ...) and maps them onto these library-agnostic kinds, so
 * callers never sniff library-specific error fields.
 */
export type TransportErrorKind = 'timeout' | 'cancelled' | 'network';

export interface TransportErrorClassification {
    readonly kind: TransportErrorKind;
    readonly cause: unknown;
}

/**
 * Abstraction over a specific HTTP library (undici, axios, node-fetch, etc.).
 */
export interface HttpTransport {
    request(options: HttpRequest): Promise<HttpResponse>;

    /**
     * Classifies an error rejected by {@link request} into the
     * transport-agnostic taxonomy. `'cancelled'` means the request was
     * aborted through the request signal — the caller (FetchOperation)
     * resolves whether that abort was a timeout or a caller cancellation.
     * Everything the library throws that is not a timeout or cancellation is
     * a `'network'` failure.
     */
    classifyError(error: unknown): TransportErrorClassification;

    close(): Promise<void>;
}

export interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | undefined;
    readonly signal?: AbortSignal;
}

export interface HttpResponse {
    readonly status: number;
    readonly statusText: string;
    readonly ok: boolean;
    readonly headers: Headers;
    text(): Promise<string>;
    json(): Promise<unknown>;
    discard(): Promise<void>;
}

export interface CreateProxyEndpointsOptions {
    readonly concurrency: number;
    readonly poolConfig: ProxyPoolConfig;
    readonly proxyCount: number;
}
