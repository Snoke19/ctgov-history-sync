export interface ProxyPoolConfig {
    readonly connections: number;
    readonly maxConnections: number;
    readonly connectTimeoutMs: number;
    readonly pipelining: number;
    readonly keepAliveTimeoutMs: number;
    readonly headersTimeoutMs: number;
    readonly bodyTimeoutMs: number;
}
