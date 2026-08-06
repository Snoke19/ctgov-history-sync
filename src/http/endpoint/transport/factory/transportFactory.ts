import { CreateProxyEndpointsOptions, HttpTransport } from '../httpTransport.js';

/**
 * Factory that creates a concrete HttpTransport for a proxy endpoint.
 *
 * Implementations of this factory are isolated from the endpoint domain and are
 * solely responsible for creating the HTTP client (with or without a proxy).
 */
export interface ProxyTransportFactory {
    create(url: string, options: CreateProxyEndpointsOptions): HttpTransport;
}
