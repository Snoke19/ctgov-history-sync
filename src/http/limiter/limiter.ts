export abstract class Limiter {
    /**
     * Attempt to acquire a token at the given moment.
     *
     * @param now  Current monotonic time in milliseconds.
     * @returns `true` if a token was successfully acquired,
     *          `false` otherwise.
     */
    public abstract tryAcquire(now: number): boolean;

    /**
     * Return the **relative** number of milliseconds to wait until
     * a token would be available, assuming no other acquisitions happen
     * in the meantime.
     *
     * @param now  Current monotonic time in milliseconds.
     * @returns A non‑negative number of milliseconds, relative to `now`.
     *          0 means a token is available immediately.
     */
    public abstract timeUntilToken(now: number): number;
}
