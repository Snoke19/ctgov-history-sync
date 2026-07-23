export class Limiter {

    /**
     * @returns {boolean}
     */
    tryAcquire() {
        throw new Error('Not implemented');
    }

    /**
     * @returns {number}
     */
    timeUntilToken() {
        throw new Error('Not implemented');
    }
}
