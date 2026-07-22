import {ProxyAgent} from 'undici';

import {RATE_LIMIT_CAPACITY, RATE_LIMIT_WINDOW,} from '../../config/config.js';

import {poolFactory} from '../poolFactory.js';
import {TokenBucket} from '../limiter/tokenBucket.js';

export class ProxyInstance {
    #limiter;
    #dispatcher;

    constructor(url) {
        this.url = url;

        this.#dispatcher = new ProxyAgent({
            uri: url,
            clientFactory: poolFactory,
        });

        this.#limiter = new TokenBucket(
            RATE_LIMIT_CAPACITY,
            RATE_LIMIT_WINDOW,
        );
    }

    tryAcquire() {
        return this.#limiter.tryAcquire();
    }

    timeUntilToken() {
        return this.#limiter.timeUntil(1);
    }

    getHandle() {
        return Object.freeze({
            url: this.url,
            dispatcher: this.#dispatcher
        });
    }
}
