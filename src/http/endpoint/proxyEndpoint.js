import {ProxyAgent} from 'undici';
import {createPoolFactory} from '../poolFactory.js';
import {Endpoint} from './endpoint.js';

export class ProxyEndpoint extends Endpoint {
    #handle;

    constructor(url, limiter = null, {proxyCount = 1, concurrency, poolConfig} = {}) {
        super(url, limiter);

        const connections = ProxyEndpoint.#resolveConnections(proxyCount, concurrency, poolConfig);
        const poolFactory = createPoolFactory(poolConfig);

        const dispatcher = new ProxyAgent({
            uri: url,
            clientFactory: (origin, opts) => poolFactory(origin, {...opts, connections}),
        });

        this.#handle = Object.freeze({url, dispatcher});
    }

    static #resolveConnections(proxyCount, concurrency, poolConfig) {
        if (!concurrency || !proxyCount) {
            return poolConfig.connections;
        }
        const target = Math.ceil(concurrency / proxyCount);
        return Math.min(poolConfig.maxConnections, Math.max(poolConfig.connections, target));
    }

    getHandle() {
        return this.#handle;
    }

    /**
     * Closes the underlying ProxyAgent and its connection pool.
     * Call this during process shutdown to avoid connection leaks.
     *
     * @returns {Promise<void>}
     */
    close() {
        return this.#handle.dispatcher.close();
    }
}
