import { ProxyEndpoint } from './proxyEndpoint.js';
import type { Limiter } from '../../limiter/limiter.js';
import { TransportFactory } from '../types/transportFactory.js';
import { CreateProxyEndpointsOptions } from '../types/endpointOptions.js';

export class ProxyEndpointFactory {
    constructor(private readonly transportFactory: TransportFactory) {}

    create(
        proxyUrl: string,
        limiter: Limiter,
        options: CreateProxyEndpointsOptions,
    ): ProxyEndpoint {
        const transport = this.transportFactory.create(proxyUrl, options);
        return new ProxyEndpoint(proxyUrl, limiter, transport);
    }
}
