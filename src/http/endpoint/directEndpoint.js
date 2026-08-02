import {Endpoint} from './endpoint.js';

export class DirectEndpoint extends Endpoint {
    #handle;

    constructor(url = 'direct', limiter = null) {
        super(url, limiter);

        this.#handle = Object.freeze({url, dispatcher: undefined});
    }

    getHandle() {
        return this.#handle;
    }

    /**
     * @returns {Promise<void>}
     */
    close() {
        return Promise.resolve();
    }
}
