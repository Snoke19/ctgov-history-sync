import { performance } from 'node:perf_hooks';
import { CallerAbortedError } from '../error/errors.js';

export interface WallClock {
    /** Current Unix timestamp in milliseconds. */
    now(): number;
}

export interface MonotonicClock {
    /**
     * Monotonic timestamp in milliseconds.
     *
     * Suitable for measuring elapsed durations and deadlines.
     * The value is not Unix time.
     */
    now(): number;
}

export interface Sleeper {
    /**
     * Suspend execution for `ms` milliseconds.
     *
     * If `abortSignal` aborts before the delay elapses, the sleep rejects early.
     */
    sleep(ms: number, abortSignal?: AbortSignal): Promise<void>;
}

export interface RandomSource {
    /** Return a value in [0, 1). */
    random(): number;
}

export const defaultSleeper: Sleeper = {
    sleep: (ms, abortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (abortSignal?.aborted) {
                reject(new CallerAbortedError());
                return;
            }

            let settled = false;

            const cleanup = (): void => {
                clearTimeout(timer);
                abortSignal?.removeEventListener('abort', onAbort);
            };

            const onAbort = (): void => {
                if (settled) return;

                settled = true;
                cleanup();
                reject(new CallerAbortedError());
            };

            const timer = setTimeout(() => {
                if (settled) return;

                settled = true;
                cleanup();
                resolve();
            }, ms);

            abortSignal?.addEventListener('abort', onAbort, { once: true });
        }),
};

/** Wall-clock time for HTTP dates such as Retry-After. */
export const defaultWallClock: WallClock = {
    now: () => Date.now(),
};

/** Monotonic time for elapsed-duration calculations. */
export const defaultMonotonicClock: MonotonicClock = {
    now: () => performance.now(),
};

export const defaultRandom: RandomSource = {
    random: () => Math.random(),
};
