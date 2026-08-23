export interface ProxyPoolConfig {
    readonly connections: number;
    readonly maxConnections: number;
    readonly connectTimeout: number;
    readonly pipelining: number;
    readonly keepAliveTimeout: number;
    readonly headersTimeout: number;
    readonly bodyTimeout: number;
}
