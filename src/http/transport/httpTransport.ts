import { ProxyPoolConfig } from '../../config/config.js';

export type TransportErrorKind = 'timeout' | 'cancelled' | 'network';

export interface TransportErrorClassification {
    readonly kind: TransportErrorKind;
    readonly cause: unknown;
}

/**
 * Abstraction over a specific HTTP library.
 *
 * Each implementation owns all knowledge of its underlying library's
 * error model and converts it into the transport-agnostic taxonomy above.
 */
export interface HttpTransport {
    request(options: HttpRequest): Promise<HttpResponse>;
    classifyError(error: unknown): TransportErrorClassification;
    close(): Promise<void>;
}

export interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
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
