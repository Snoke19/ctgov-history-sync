export class Endpoint {
    #url;
    #limiter;

    constructor(url, limiter) {
        if (new.target === Endpoint) {
            throw new TypeError('Endpoint is abstract and cannot be instantiated directly');
        }

        this.#url = url;
        this.#limiter = limiter;

        Object.freeze(this);
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

    /**
     * @returns {{url: string, dispatcher: *}}
     */
    getHandle() {
        throw new TypeError('Abstract method getHandle() must be implemented');
    }

    /**
     * Releases any resources held by this endpoint.
     *
     * Concrete subclasses must implement this method.
     * Endpoints without resources should implement it as a no-op.
     *
     * @returns {Promise<void>}
     */
    close() {
        throw new TypeError('Abstract method close() must be implemented');
    }
}
