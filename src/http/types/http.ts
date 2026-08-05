import { ProxyPoolConfig } from '../../config/config.js';

export type QueryParamValue = string | number | boolean;

export type QueryParamInput = QueryParamValue | string[] | null | undefined;

export interface QueryParams {
    readonly [key: string]: QueryParamInput;
}

export interface HttpClientOptions {
    useProxy?: boolean;
    proxyUrls?: string;
    useRateLimit?: boolean;
    rateLimitCapacity: number;
    rateLimitWindow: number;
    acquireTimeout: number;
    concurrency: number;
    poolConfig: ProxyPoolConfig;
    proxyType: string;
}

export interface RequestOptions {
    allow404?: boolean;
    errorBodyPreviewLength?: number;
    retryableStatusCodes?: ReadonlySet<number>;
}

export interface FetchJsonRequestOptions extends RequestOptions {
    allow404?: boolean;
    method?: string;
    timeoutMs?: number;
    deadline?: number;
    maxRetries?: number;
    idempotent: boolean;
}
