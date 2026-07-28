import {Endpoint} from './endpoint.js';

export class DirectEndpoint extends Endpoint {
    #handle;

    constructor(url = 'direct', limiter = null) {
        super(url, limiter);

        this.#handle = Object.freeze({
            url,
            dispatcher: undefined,
        });
    }

    getHandle() {
        return this.#handle;
    }

    /**
     * No-op: DirectEndpoint uses Node's default dispatcher which is managed
     * globally and must not be closed here.
     *
     * @returns {Promise<void>}
     */
    close() {
        return Promise.resolve();
    }
}
