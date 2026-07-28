import {ProxyAgent} from 'undici';
import {poolFactory} from '../poolFactory.js';
import {Endpoint} from './endpoint.js';

export class ProxyEndpoint extends Endpoint {
    #handle;

    constructor(url, limiter = null) {
        super(url, limiter);

        const dispatcher = new ProxyAgent({
            uri: url,
            clientFactory: poolFactory,
        });

        this.#handle = Object.freeze({
            url,
            dispatcher,
        });
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
