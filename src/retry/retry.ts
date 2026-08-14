import { CallerAbortedError, TrialError } from '../error/errors.js';
import { defaultSleeper, Sleeper } from '../http/clock.js';
import { BusinessOperation } from './businessOperation.js';

export class Retry<T> implements BusinessOperation<T> {
    private readonly op: BusinessOperation<T>;
    private readonly maxRetries: number;
    private readonly shouldRetry: (error: TrialError) => boolean;
    private readonly delayMs: number | ((attempt: number, error: TrialError) => number);
    private readonly sleep: Sleeper['sleep'];
    private readonly signal: AbortSignal | undefined;

    /**
     * @param op          The operation to execute, retried on failure.
     * @param maxRetries  Number of retries after the initial attempt.
     * @param shouldRetry  Decides whether a failed attempt warrants another try.
     * @param delayMs     Fixed delay between attempts, or a function of the
     *                    zero-indexed retry attempt and the last error.
     * @param sleep       Async delay implementation. Defaults to the shared
     *                    HTTP-layer sleeper.
     * @param signal      Caller-controlled cancellation signal. Forwarded into
     *                    the backoff sleep so an abort cuts the wait short
     *                    instead of running it to completion.
     */
    constructor(
        op: BusinessOperation<T>,
        maxRetries: number,
        shouldRetry: (error: TrialError) => boolean,
        delayMs: number | ((attempt: number, error: TrialError) => number),
        sleep: Sleeper['sleep'] = defaultSleeper.sleep,
        signal?: AbortSignal,
    ) {
        if (!Number.isInteger(maxRetries) || maxRetries < 0) {
            throw new TypeError('maxRetries must be a non-negative integer');
        }

        this.op = op;
        this.maxRetries = maxRetries;
        this.shouldRetry = shouldRetry;
        this.delayMs = delayMs;
        this.sleep = sleep;
        this.signal = signal;
    }

    async perform(): Promise<T> {
        let retryCount = 0;

        while (true) {
            try {
                return await this.op.perform();
            } catch (error) {
                if (!(error instanceof TrialError)) {
                    throw error;
                }

                if (!this.shouldRetry(error)) {
                    throw error;
                }

                if (retryCount >= this.maxRetries) {
                    throw error;
                }

                const delay = typeof this.delayMs === 'function' ? this.delayMs(retryCount, error) : this.delayMs;

                retryCount++;

                await this.abortableSleep(Math.max(0, delay));
            }
        }
    }

    /**
     * Sleep between retries, cutting the wait short if the caller aborts.
     *
     * The shared sleeper is abort-aware and rejects early on cancellation;
     * a rejection is coerced into the canonical {@link CallerAbortedError}.
     * Injected sleepers that ignore the signal and just resolve are caught by
     * the re-check, so an abort that arrived during the wait still cancels
     * before the next attempt.
     */
    private async abortableSleep(ms: number): Promise<void> {
        if (this.signal?.aborted) {
            throw new CallerAbortedError();
        }

        try {
            await this.sleep(ms, this.signal);
        } catch (error) {
            if (this.signal?.aborted) {
                throw new CallerAbortedError();
            }
            throw error;
        }

        if (this.signal?.aborted) {
            throw new CallerAbortedError();
        }
    }
}
