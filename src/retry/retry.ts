import { createLogger } from '../config/logging.js';
import { CallerAbortedError, TrialError, UnexpectedError } from '../error/errors.js';
import { defaultSleeper } from '../http/clock.js';
import type { Sleeper } from '../http/clock.js';
import { BusinessOperation } from './businessOperation.js';

const logger = createLogger(import.meta.url);

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
            } catch (error: unknown) {
                const trialError = TrialError.normalize(error);

                if (trialError instanceof UnexpectedError) {
                    throw trialError;
                }

                if (!this.shouldRetry(trialError)) {
                    logger.debug(
                        {
                            errorType: trialError.name,
                            errorMessage: trialError.message,
                        },
                        'Operation failed; error is not retryable',
                    );

                    throw trialError;
                }

                if (retryCount >= this.maxRetries) {
                    logger.warn(
                        {
                            attempts: retryCount + 1,
                            maxRetries: this.maxRetries,
                            errorType: trialError.name,
                            errorMessage: trialError.message,
                        },
                        'Operation failed; retries exhausted',
                    );

                    throw trialError;
                }

                const delay = typeof this.delayMs === 'function' ? this.delayMs(retryCount, trialError) : this.delayMs;

                retryCount++;

                logger.warn(
                    {
                        attempt: retryCount,
                        maxRetries: this.maxRetries,
                        delayMs: Math.max(0, delay),
                        errorType: trialError.name,
                        errorMessage: trialError.message,
                    },
                    'Operation failed; retrying',
                );

                await this.abortableSleep(Math.max(0, delay));
            }
        }
    }

    private async abortableSleep(ms: number): Promise<void> {
        if (this.signal?.aborted) {
            throw new CallerAbortedError();
        }

        try {
            await this.sleep(ms, this.signal);
        } catch (error: unknown) {
            if (this.signal?.aborted) {
                throw new CallerAbortedError('The retry backoff was aborted by the caller.', { cause: error });
            }

            throw TrialError.normalize(error);
        }

        if (this.signal?.aborted) {
            throw new CallerAbortedError();
        }
    }
}
