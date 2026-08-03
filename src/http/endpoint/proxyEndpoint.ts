import {ProxyAgent} from 'undici';
import {createPoolFactory} from '../poolFactory.js';
import {Endpoint, EndpointHandle} from './endpoint.js';
import {ProxyPoolConfig} from "../../config/config.js";
import {Limiter} from "../limiter/limiter.js";

export interface CreateProxyEndpointsOptions {
    concurrency: number;
    poolConfig: ProxyPoolConfig;
    proxyCount: number;
}

export class ProxyEndpoint extends Endpoint {
    private readonly handle: EndpointHandle;

    constructor(url: string, limiter: Limiter, createProxyEndpointsOptions: CreateProxyEndpointsOptions) {
        super(url, limiter);

        const connections = ProxyEndpoint.#resolveConnections(
            createProxyEndpointsOptions.proxyCount,
            createProxyEndpointsOptions.concurrency,
            createProxyEndpointsOptions.poolConfig
        );
        const poolFactory = createPoolFactory(createProxyEndpointsOptions.poolConfig);

        const dispatcher = new ProxyAgent({
            uri: url,
            clientFactory: (origin, opts) => poolFactory(origin, {...opts, connections}),
        });

        this.handle = Object.freeze({url, dispatcher});
    }

    static #resolveConnections(proxyCount: number, concurrency: number, poolConfig: ProxyPoolConfig) {
        if (!concurrency || !proxyCount) {
            return poolConfig.connections;
        }

        return Math.min(
            poolConfig.maxConnections,
            Math.max(
                poolConfig.connections,
                Math.ceil(concurrency / proxyCount),
            ),
        );
    }

    getHandle(): EndpointHandle {
        return this.handle;
    }

    close(): Promise<void> {
        if (!this.handle.dispatcher) {
            return Promise.resolve();
        }

        return this.handle.dispatcher.close();
    }
}
