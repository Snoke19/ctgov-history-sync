export class Limiter {
    /**
     * @param {number} [now]
     * @returns {boolean}
     */
    tryAcquire(now) {
        throw new Error('Not implemented');
    }

    /**
     * @param {number} [now]
     * @returns {number}
     */
    timeUntilToken(now) {
        throw new Error('Not implemented');
    }
}
