import { createLogger } from '../config/logging.js';
import { CallerAbortedError, HttpException, TrialError, UnexpectedError } from '../error/errors.js';
import { defaultSleeper } from '../http/clock.js';
import type { Sleeper } from '../http/clock.js';
import { BusinessOperation } from './businessOperation.js';

const logger = createLogger(import.meta.url);

type DelayMs = number | ((retryAttempt: number, error: TrialError) => number);

export class Retry<T> implements BusinessOperation<T> {
    private readonly operation: BusinessOperation<T>;
    private readonly maxAttempts: number;
    private readonly shouldRetry: (error: TrialError) => boolean;
    private readonly delayMs: DelayMs;
    private readonly sleep: Sleeper['sleep'];
    private readonly signal: AbortSignal | undefined;

    /**
     * @param operation   The operation to execute, retried on failure.
     * @param maxAttempts Maximum number of total attempts, including the initial attempt.
     * @param shouldRetry Decides whether a failed attempt warrants another try.
     *                    If it throws, that error propagates immediately.
     * @param delayMs     Fixed delay in ms between attempts, or a function receiving
     *                    the zero-indexed retry count and the triggering error.
     * @param sleep       Async delay implementation. Defaults to the shared HTTP-layer sleeper.
     * @param signal      Caller-controlled cancellation. Checked before the first attempt
     *                    and before each backoff sleep, so an abort always stops execution
     *                    before the next unit of work begins.
     */
    constructor(
        operation: BusinessOperation<T>,
        maxAttempts: number,
        shouldRetry: (error: TrialError) => boolean,
        delayMs: DelayMs,
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
        if (this.signal?.aborted) {
            throw new CallerAbortedError();
        }

        const startedAt = Date.now();

        for (let attempt = 1; ; attempt++) {
            try {
                const result = await this.operation.perform();

                if (attempt > 1) {
                    this.logRecovery(attempt, attempt - 1, startedAt);
                }

                return result;
            } catch (error: unknown) {
                const trialError = TrialError.normalize(error);

                if (trialError instanceof UnexpectedError) {
                    throw trialError;
                }

                // Caller cancellation is a control-flow signal, not a retry-policy decision.
                // It always takes precedence over shouldRetry().
                if (trialError instanceof CallerAbortedError) {
                    throw trialError;
                }

                if (!this.shouldRetry(trialError)) {
                    this.logNotRetryable(trialError);
                    throw trialError;
                }

                if (attempt >= this.maxAttempts) {
                    this.logExhausted(attempt, trialError, startedAt);
                    throw trialError;
                }

                const retryIndex = attempt - 1;
                const delayMs = this.resolveDelay(retryIndex, trialError);

                this.logRetrying(attempt + 1, delayMs, trialError);

                await this.sleepWithAbortCheck(delayMs);
            }
        }
    }

    private resolveDelay(retryIndex: number, error: TrialError): number {
        const raw = typeof this.delayMs === 'function' ? this.delayMs(retryIndex, error) : this.delayMs;
        return Math.max(0, raw);
    }

    private async sleepWithAbortCheck(ms: number): Promise<void> {
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

        // Safety net: a conforming Sleeper rejects when the signal aborts during
        // the delay. Re-check after resolution so Retry still honors cancellation
        // if a custom Sleeper resolves despite an abort (for example, a test double).
        if (this.signal?.aborted) {
            throw new CallerAbortedError();
        }
    }

    private logRecovery(attempt: number, retries: number, startedAt: number): void {
        logger.debug(
            {
                attempts: attempt,
                retries,
                durationMs: Date.now() - startedAt,
            },
            'Operation recovered after retry',
        );
    }

    private logNotRetryable(error: TrialError): void {
        logger.debug(
            {
                err: error,
                errorType: error.name,
            },
            'Operation failed; error is not retryable',
        );
    }

    private logExhausted(attempt: number, error: TrialError, startedAt: number): void {
        logger.warn(
            {
                attempts: attempt,
                maxAttempts: this.maxAttempts,
                err: error,
                errorType: error.name,
                durationMs: Date.now() - startedAt,
            },
            'Operation failed; maximum attempts reached',
        );
    }

    private logRetrying(nextAttempt: number, delayMs: number, error: TrialError): void {
        logger.warn(
            {
                attempt: nextAttempt,
                maxAttempts: this.maxAttempts,
                delayMs,
                reason: error.name,
                statusCode: error instanceof HttpException ? error.status : undefined,
                err: error,
                errorType: error.name,
            },
            'Operation failed; retrying',
        );
    }
}
