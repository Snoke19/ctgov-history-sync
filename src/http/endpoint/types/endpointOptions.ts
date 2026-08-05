import type { ProxyPoolConfig } from '../../../config/config.js';

export interface CreateProxyEndpointsOptions {
    readonly concurrency: number;
    readonly poolConfig: ProxyPoolConfig;
    readonly proxyCount: number;

    /**
     * Proxy type. Used by the transport factory to select
     * the corresponding implementation (HTTP, SOCKS4, SOCKS5, etc.).
     *
     * Defaults to 'http'.
     */
    readonly proxyType?: string;
}
