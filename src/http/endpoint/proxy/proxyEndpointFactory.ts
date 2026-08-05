import {ProxyEndpoint} from './proxyEndpoint.js';
import type {Limiter} from '../../limiter/limiter.js';
import type {CreateProxyEndpointsOptions} from '../types/endpointOptions.js';
import type {DispatcherFactory} from '../types/dispatcherFactory.js';

export class ProxyEndpointFactory {
    constructor(private readonly dispatcherFactory: DispatcherFactory) {}

    create(proxyUrl: string, limiter: Limiter, options: CreateProxyEndpointsOptions): ProxyEndpoint {
        const dispatcher = this.dispatcherFactory.create(proxyUrl, options);
        return new ProxyEndpoint(proxyUrl, limiter, dispatcher);
    }
}