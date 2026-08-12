/**
 * Shared clock and sleeper for the HTTP layer.
 *
 * All time-dependent components (FetchOperation, EndpointManager,
 * TokenBucket, Retry) must use this single clock source and sleeper.
 * Mixing time bases produces meaningless deadlines.
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