export abstract class Limiter {
    public abstract tryAcquire(now: number): boolean;

    /**
     * Determines how long the caller must wait before the next request can be sent.
     *
     * @param now - Current monotonic time in milliseconds (e.g., from `performance.now()`).
     *              The implementation MUST use this value for all time-related calculations
     *              and MUST NOT rely on `Date.now()` or any other clock.
     * @returns The relative wait time in milliseconds from the given `now`.
     *          - `0` if a token is immediately available.
     *          - A positive number of milliseconds to wait before the next token becomes
     *            available, assuming no other tokens are consumed in the meantime.
     */
    public abstract timeUntilToken(now: number): number;
}
