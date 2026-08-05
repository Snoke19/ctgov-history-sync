import { ProxyPoolConfig } from '../../../config/config.js';

export function resolveConnections(
    proxyCount: number,
    concurrency: number,
    poolConfig: ProxyPoolConfig,
): number {
    if (!concurrency || !proxyCount) {
        return poolConfig.connections;
    }

    return Math.min(
        poolConfig.maxConnections,
        Math.max(poolConfig.connections, Math.ceil(concurrency / proxyCount)),
    );
}
