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
     * Releases any resources held by this endpoint (e.g. connection pool).
     * Subclasses with a dispatcher MUST override this and call dispatcher.close().
     * Subclasses without a dispatcher may leave this as a no-op.
     *
     * @returns {Promise<void>}
     */
    close() {
        throw new Error('close() must be implemented');
    }
}
