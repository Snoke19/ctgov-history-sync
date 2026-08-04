import {ProxyAgent, Dispatcher} from 'undici';
import type {DispatcherFactory} from '../types/dispatcherFactory.js';
import type {CreateProxyEndpointsOptions} from '../types/endpointOptions.js';
import {createPoolFactory} from '../../poolFactory.js';
import {resolveConnections} from './resolveConnections.js';

export class UndiciProxyDispatcherFactory implements DispatcherFactory {
    create(proxyUrl: string, options: CreateProxyEndpointsOptions): Dispatcher {

        const connections = resolveConnections(options.proxyCount, options.concurrency, options.poolConfig);
        const poolFactory = createPoolFactory(options.poolConfig);

        return new ProxyAgent({
            uri: proxyUrl,
            clientFactory: (origin, opts) => poolFactory(origin, {...opts, connections}),
        });
    }
}