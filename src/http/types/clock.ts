/**
 * Abstraction over time so tests can run without real setTimeout / Date.now.
 * EndpointManager already supports injected sleep — this extends the pattern
 * to Retry (backoff) and TokenBucket (rate-limit window tracking).
 *
 * THIS is the single clock source for the entire HTTP layer. FetchOperation
 * (fetch deadline budgets), EndpointManager (endpoint acquisition deadlines)
 * and TokenBucket (rate-limit refill windows) must all measure time on this
 * one source. Do NOT introduce a second time base (e.g. performance.now())
 * for deadline math — mixing epoch and process-relative timestamps produces
 * meaningless deadlines that are impossible to reason about.
 *
 * The default is Date.now() (epoch ms), which matches the documented semantics
 * of `FetchJsonRequestOptions.deadline` ("Absolute deadline (epoch ms)").
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

/** Production default — real time, real Math.random. */
export const defaultClock: Clock = {
    now: () => Date.now(),
};

export const defaultRandom: RandomSource = {
    random: () => Math.random(),
};
