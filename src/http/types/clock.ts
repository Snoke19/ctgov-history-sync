/**
 * Abstraction over time so tests can run without real setTimeout / Date.now.
 * EndpointManager already supports injected sleep — this extends the pattern
 * to Retry (backoff) and TokenBucket (rate-limit window tracking).
 *
 * THIS is the single clock source AND the single sleep implementation for the
 * entire HTTP layer. FetchOperation (fetch deadline budgets), EndpointManager
 * (endpoint acquisition deadlines) and TokenBucket (rate-limit refill windows)
 * must all measure time on this one source, and EndpointManager, TokenBucket
 * and Retry must all suspend on this one sleeper. Do NOT introduce a second
 * time base (e.g. performance.now()) or a second sleep helper (e.g. an inline
 * `new Promise(resolve => setTimeout(resolve, ms))` wrapper or a separate
 * `timers/promises.setTimeout`) for deadline math — mixing epoch and
 * process-relative timestamps produces meaningless deadlines that are
 * impossible to reason about, and duplicate sleepers drift out of sync with
 * each other.
 *
 * The default clock is Date.now() (epoch ms), which matches the documented
 * semantics of `FetchJsonRequestOptions.deadline` ("Absolute deadline (epoch
 * ms)").
 */

export interface Clock {
    /** Current timestamp in milliseconds (like Date.now). */
    now(): number;
}

export interface Sleeper {
    /**
     * Suspend execution for `ms` milliseconds.
     *
     * If `signal` is provided and aborts before the delay elapses, the sleep
     * rejects early so the caller can surface cancellation promptly. Callers
     * that provide no signal simply wait the full duration.
     */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RandomSource {
    /** Return a value in [0, 1). */
    random(): number;
}

function abortError(): Error {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

/**
 * Production default — real time, cooperative early-exit on cancellation.
 *
 * Built on the global `setTimeout` (not `node:timers/promises`) so that test
 * setups using fake timers observe the same faked behavior they would for any
 * other `setTimeout` call.
 */
export const defaultSleeper: Sleeper = {
    sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                reject(abortError());
            } else {
                const onAbort = (): void => {
                    clearTimeout(timer);
                    reject(abortError());
                };

                const timer = setTimeout(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, ms);

                signal?.addEventListener('abort', onAbort, { once: true });
            }
        }),
};

/** Production default — real time. */
export const defaultClock: Clock = {
    now: () => Date.now(),
};

export const defaultRandom: RandomSource = {
    random: () => Math.random(),
};