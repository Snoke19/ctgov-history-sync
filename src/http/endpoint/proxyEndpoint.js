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
}
