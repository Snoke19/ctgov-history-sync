import type { Dispatcher } from 'undici';
import type { CreateProxyEndpointsOptions } from './endpointOptions.js';

export interface DispatcherFactory {

    create(proxyUrl: string, options: CreateProxyEndpointsOptions): Dispatcher;
}