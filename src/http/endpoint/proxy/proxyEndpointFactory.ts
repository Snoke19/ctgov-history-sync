import {ProxyEndpoint} from './proxyEndpoint.js';
import type {Limiter} from '../../limiter/limiter.js';
import type {CreateProxyEndpointsOptions} from '../types/endpointOptions.js';
import type {DispatcherFactory} from '../types/dispatcherFactory.js';
import {UndiciProxyDispatcherFactory} from './undiciProxyDispatcherFactory.js';

export class ProxyEndpointFactory {
    constructor(private readonly dispatcherFactory: DispatcherFactory = new UndiciProxyDispatcherFactory()) {}

    create(proxyUrl: string, limiter: Limiter, options: CreateProxyEndpointsOptions): ProxyEndpoint {
        const dispatcher = this.dispatcherFactory.create(proxyUrl, options);
        return new ProxyEndpoint(proxyUrl, limiter, dispatcher);
    }
}