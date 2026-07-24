export class Endpoint {
    #url;
    #limiter;

    constructor(url, limiter) {
        this.#url = url;
        this.#limiter = limiter;
    }

    get url() {
        return this.#url;
    }

    tryAcquire() {
        return this.#limiter ? this.#limiter.tryAcquire() : true;
    }

    timeUntilToken() {
        return this.#limiter ? this.#limiter.timeUntilToken() : 0;
    }

    getHandle() {
        throw new Error('getHandle() must be implemented');
    }
}
