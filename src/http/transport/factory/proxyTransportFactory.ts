import type { HttpTransport } from '../httpTransport.js';

/**
 * Runtime context required to create a proxy transport.
 *
 * Transport implementations may combine this context with their own
 * configuration (e.g. Undici pool settings) to build the transport.
 */
export interface ProxyTransportContext {
    readonly concurrency: number;
    readonly proxyCount: number;
}

/**
 * Factory that creates a concrete HttpTransport for a proxy endpoint.
 *
 * Implementations of this factory are isolated from the endpoint domain and are
 * solely responsible for creating the HTTP client (with or without a proxy).
 */
export interface ProxyTransportFactory {
    create(url: string, context: ProxyTransportContext): HttpTransport;
}
