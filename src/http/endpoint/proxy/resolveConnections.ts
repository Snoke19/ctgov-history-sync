import type { ProxyPoolConfig } from '../../../config/types.js';

export function resolveConnections(proxyCount: number, concurrency: number, poolConfig: ProxyPoolConfig): number {
    if (!concurrency || !proxyCount) {
        return poolConfig.connections;
    }

    const perProxy = Math.ceil(concurrency / proxyCount);
    return Math.min(poolConfig.maxConnections, Math.max(poolConfig.connections, perProxy));
}
