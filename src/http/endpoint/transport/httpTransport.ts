import { ProxyPoolConfig } from '../../../config/config.js';

/**
 * Abstraction over a specific HTTP library (undici, axios, node-fetch, etc.).
 */
export interface HttpTransport {
    request(options: HttpRequest): Promise<HttpResponse>;
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
