import { createLogger } from '../config/logging.js';
import { CallerAbortedError, HttpException, TrialError, UnexpectedError } from '../error/errors.js';
import { defaultSleeper } from '../http/clock.js';
import type { Sleeper } from '../http/clock.js';
import { BusinessOperation } from './businessOperation.js';

const logger = createLogger(import.meta.url);

export class Retry<T> implements BusinessOperation<T> {
    private readonly operation: BusinessOperation<T>;
    private readonly maxAttempts: number;
    private readonly shouldRetry: (error: TrialError) => boolean;
    private readonly delayMs: number | ((retryAttempt: number, error: TrialError) => number);
    private readonly sleep: Sleeper['sleep'];
    private readonly signal: AbortSignal | undefined;

    /**
     * @param operation   The operation to execute, retried on failure.
     * @param maxAttempts Maximum number of total attempts, including the initial attempt.
     * @param shouldRetry Decides whether a failed attempt warrants another try.
     * @param delayMs     Fixed delay between attempts, or a function of the
     *                    zero-indexed retry attempt and the last error.
     * @param sleep       Async delay implementation. Defaults to the shared
     *                    HTTP-layer sleeper.
     * @param signal      Caller-controlled cancellation signal. Forwarded into
     *                    the backoff sleep so an abort cuts the wait short
     *                    instead of running it to completion.
     */
    constructor(
        operation: BusinessOperation<T>,
        maxAttempts: number,
        shouldRetry: (error: TrialError) => boolean,
        delayMs: number | ((retryAttempt: number, error: TrialError) => number),
        sleep: Sleeper['sleep'] = defaultSleeper.sleep,
        signal?: AbortSignal,
    ) {
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
            throw new TypeError(`maxAttempts must be a positive integer. value is ${maxAttempts}`);
        }

        this.operation = operation;
        this.maxAttempts = maxAttempts;
        this.shouldRetry = shouldRetry;
        this.delayMs = delayMs;
        this.sleep = sleep;
        this.signal = signal;
    }

    async perform(): Promise<T> {
        let retries = 0;
        const startedAt = Date.now();

        while (true) {
            const attempt = retries + 1;

            try {
                const result = await this.operation.perform();

                if (retries > 0) {
                    this.logRecovered(attempt, retries, startedAt);
                }

                return result;
            } catch (error: unknown) {
                const trialError = TrialError.normalize(error);

                if (trialError instanceof UnexpectedError) {
                    throw trialError;
                }

                if (!this.shouldRetry(trialError)) {
                    this.logNotRetryable(trialError);
                    throw trialError;
                }

                if (attempt >= this.maxAttempts) {
                    this.logMaxAttempts(attempt, trialError, startedAt);
                    throw trialError;
                }

                const delay = typeof this.delayMs === 'function' ? this.delayMs(retries, trialError) : this.delayMs;

                const nextAttempt = attempt + 1;

                this.logRetry(nextAttempt, delay, trialError);

                await this.abortableSleep(Math.max(0, delay));

                retries++;
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

    private logRecovered(attempts: number, retries: number, startedAt: number): void {
        logger.debug(
            {
                attempts,
                retries,
                durationMs: Date.now() - startedAt,
            },
            'Operation recovered after retry',
        );
    }

    private logNotRetryable(trialError: TrialError): void {
        logger.debug(
            {
                err: trialError,
                errorType: trialError.name,
            },
            'Operation failed; error is not retryable',
        );
    }

    private logMaxAttempts(attempt: number, trialError: TrialError, startedAt: number): void {
        logger.warn(
            {
                attempts: attempt,
                maxAttempts: this.maxAttempts,
                err: trialError,
                errorType: trialError.name,
                durationMs: Date.now() - startedAt,
            },
            'Operation failed; maximum attempts reached',
        );
    }

    private logRetry(nextAttempt: number, delayMs: number, trialError: TrialError): void {
        logger.warn(
            {
                attempt: nextAttempt,
                maxAttempts: this.maxAttempts,
                delayMs,
                reason: trialError.name,
                statusCode: trialError instanceof HttpException ? trialError.status : undefined,
                err: trialError,
                errorType: trialError.name,
            },
            'Operation failed; retrying',
        );
    }
}
