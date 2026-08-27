import { env, parseStatusCodes, validateConfig } from './configValidation.js';
import { defaults } from './defaults.js';
import type { ProxyPoolConfig } from './types.js';

export interface AppConfig {
    readonly api: {
        readonly baseUrl: string;
        readonly detailUrl: string;
        readonly pageSize: number;
    };
    readonly http: {
        readonly concurrency: number;
        readonly requestAbortTimeoutMs: number;
        readonly retryBaseDelayMs: number;
        readonly maxRetries: number;
        readonly retryableStatusCodes: ReadonlySet<number>;
        readonly backoffCapMs: number;
        readonly defaultUserAgent: string;
        readonly retryOnTimeout: boolean;
        readonly retryOnNetworkError: boolean;
    };
    readonly proxy: {
        readonly urls: string;
        readonly pool: ProxyPoolConfig;
    };
    readonly rateLimit: {
        readonly capacity: number;
        readonly windowMs: number;
    };
    readonly endpoint: {
        readonly acquireTimeoutMs: number;
    };
    readonly logging: {
        readonly level: string;
        readonly toFile: string;
        readonly nodeEnv: string;
    };
}

/**
 * Loads typed configuration from environment.
 *
 * Flow: environment → loadConfig() → AppConfig → composition root → dependencies
 *
 * No module should import from `config.ts` globals after this.
 * Call this once at the application boundary (src/index.ts) and pass the
 * resulting AppConfig explicitly.
 */
export function loadConfig(): AppConfig {
    const apiBaseUrl = env.str('API_BASE_URL', defaults.API_BASE_URL);
    const apiDetailUrl = env.str('API_DETAIL_URL', defaults.API_DETAIL_URL);
    const pageSize = env.int('PAGE_SIZE', defaults.PAGE_SIZE, { positive: true });

    const concurrency = env.int('CONCURRENCY', defaults.CONCURRENCY, { positive: true });
    const requestAbortTimeoutMs = env.int('REQUEST_ABORT_TIMEOUT_MS', defaults.REQUEST_ABORT_TIMEOUT_MS, {
        positive: true,
    });
    const retryBaseDelayMs = env.int('RETRY_BASE_DELAY_MS', defaults.RETRY_BASE_DELAY_MS, { positive: true });
    const maxRetries = env.int('MAX_RETRIES', defaults.MAX_RETRIES, { nonNegative: true });
    const retryableStatusCodes = Object.freeze(parseStatusCodes('RETRYABLE_STATUS_CODES', defaults.RETRYABLE_STATUS_CODES));
    const backoffCapMs = env.int('BACKOFF_CAP_MS', defaults.BACKOFF_CAP_MS, { positive: true });
    const defaultUserAgent = env.str('DEFAULT_USER_AGENT', defaults.DEFAULT_USER_AGENT);
    const retryOnTimeout = env.bool('RETRY_ON_TIMEOUT', defaults.RETRY_ON_TIMEOUT);
    const retryOnNetworkError = env.bool('RETRY_ON_NETWORK_ERROR', defaults.RETRY_ON_NETWORK_ERROR);

    const proxyUrls = env.str('PROXY_URLS', defaults.PROXY_URLS);
    const proxyPoolConnections = env.int('PROXY_POOL_CONNECTIONS', defaults.PROXY_POOL_CONNECTIONS, { positive: true });
    const maxPoolConnections = env.int('MAX_POOL_CONNECTIONS', defaults.MAX_POOL_CONNECTIONS, { positive: true });
    const proxyPoolPipelining = env.int('PROXY_POOL_PIPELINING', defaults.PROXY_POOL_PIPELINING, { positive: true });
    const proxyPoolKeepAliveTimeoutMs = env.int(
        'PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS',
        defaults.PROXY_POOL_KEEP_ALIVE_TIMEOUT_MS,
        { positive: true },
    );
    const proxyPoolHeadersTimeoutMs = env.int(
        'PROXY_POOL_HEADERS_TIMEOUT_MS',
        defaults.PROXY_POOL_HEADERS_TIMEOUT_MS,
        {
            positive: true,
        },
    );
    const proxyPoolBodyTimeoutMs = env.int('PROXY_POOL_BODY_TIMEOUT_MS', defaults.PROXY_POOL_BODY_TIMEOUT_MS, {
        positive: true,
    });
    const proxyPoolConnectTimeoutMs = env.int(
        'PROXY_POOL_CONNECT_TIMEOUT_MS',
        defaults.PROXY_POOL_CONNECT_TIMEOUT_MS,
        {
            positive: true,
        },
    );

    const proxyPool: ProxyPoolConfig = Object.freeze({
        connections: proxyPoolConnections,
        maxConnections: maxPoolConnections,
        pipelining: proxyPoolPipelining,
        keepAliveTimeoutMs: proxyPoolKeepAliveTimeoutMs,
        headersTimeoutMs: proxyPoolHeadersTimeoutMs,
        bodyTimeoutMs: proxyPoolBodyTimeoutMs,
        connectTimeoutMs: proxyPoolConnectTimeoutMs,
    });

    const rateLimitCapacity = env.int('RATE_LIMIT_CAPACITY', defaults.RATE_LIMIT_CAPACITY, { positive: true });
    const rateLimitWindow = env.int('RATE_LIMIT_WINDOW', defaults.RATE_LIMIT_WINDOW, { positive: true });
    const endpointAcquireTimeoutMs = env.int('ENDPOINT_ACQUIRE_TIMEOUT_MS', defaults.ENDPOINT_ACQUIRE_TIMEOUT_MS, {
        positive: true,
    });

    const logLevel = env.str('LOG_LEVEL', defaults.LOG_LEVEL);
    const logToFile = env.str('LOG_TO_FILE', defaults.LOG_TO_FILE);
    const nodeEnv = env.str('NODE_ENV', defaults.NODE_ENV);

    validateConfig({ apiBaseUrl, apiDetailUrl });

    return Object.freeze({
        api: Object.freeze({
            baseUrl: apiBaseUrl,
            detailUrl: apiDetailUrl,
            pageSize,
        }),
        http: Object.freeze({
            concurrency,
            requestAbortTimeoutMs,
            retryBaseDelayMs,
            maxRetries,
            retryableStatusCodes,
            backoffCapMs,
            defaultUserAgent,
            retryOnTimeout,
            retryOnNetworkError,
        }),
        proxy: Object.freeze({
            urls: proxyUrls,
            pool: proxyPool,
        }),
        rateLimit: Object.freeze({
            capacity: rateLimitCapacity,
            windowMs: rateLimitWindow,
        }),
        endpoint: Object.freeze({
            acquireTimeoutMs: endpointAcquireTimeoutMs,
        }),
        logging: Object.freeze({
            level: logLevel,
            toFile: logToFile,
            nodeEnv,
        }),
    });
}
