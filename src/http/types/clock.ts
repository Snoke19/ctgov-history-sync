/**
 * Abstraction over time so tests can run without real setTimeout / Date.now.
 * EndpointManager already supports injected sleep — this extends the pattern
 * to Retry (backoff) and TokenBucket (rate-limit window tracking).
 */

export interface Clock {
    /** Current timestamp in milliseconds (like Date.now). */
    now(): number;
}

export interface Sleeper {
    /** Suspend execution for `ms` milliseconds. */
    sleep(ms: number): Promise<void>;
}

export interface RandomSource {
    /** Return a value in [0, 1). */
    random(): number;
}

/** Production defaults — real time, real Math.random. */
export const defaultSleeper: Sleeper = {
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export const defaultClock: Clock = {
    now: () => Date.now(),
};

export const defaultRandom: RandomSource = {
    random: () => Math.random(),
};
