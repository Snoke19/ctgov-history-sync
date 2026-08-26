import { createLogger } from '../config/logging.js';
import {
    CallerAbortedError,
    ConfigurationError,
    HttpException,
    RetryDelayCalculationError,
    TrialError,
    UnexpectedError,
} from '../error/errors.js';
import { defaultMonotonicClock, defaultSleeper } from '../http/clock.js';
import type { MonotonicClock, Sleeper } from '../http/clock.js';
import { BusinessOperation } from './businessOperation.js';

const logger = createLogger(import.meta.url);

type RetryHaltReason = 'unexpected' | 'aborted' | 'not-retryable' | 'exhausted';
type RetryDirective = { action: 'retry'; delayMs: number } | { action: 'halt'; reason: RetryHaltReason };
type RetryDelayCalculator = (retryAttempt: number, error: TrialError) => number;
type RetryDelay = number | RetryDelayCalculator;

type AttemptResult<T> = { ok: true; value: T } | { ok: false; error: TrialError };

export class Retry<T> implements BusinessOperation<T> {
    private readonly operation: BusinessOperation<T>;
    private readonly maxAttempts: number;
    private readonly shouldRetry: (error: TrialError) => boolean;
    private readonly retryDelay: RetryDelay;
    private readonly sleep: Sleeper['sleep'];
    private readonly signal: AbortSignal | undefined;
    private readonly clock: MonotonicClock['now'];

    constructor(
        operation: BusinessOperation<T>,
        maxAttempts: number,
        shouldRetry: (error: TrialError) => boolean,
        retryDelay: RetryDelay,
        sleep: Sleeper['sleep'] = defaultSleeper.sleep,
        signal?: AbortSignal,
        clock: MonotonicClock['now'] = defaultMonotonicClock.now,
    ) {
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
            throw new ConfigurationError(`maxAttempts must be a positive integer. value is ${maxAttempts}`);
        }

        if (typeof retryDelay === 'number') {
            this.validateDelay(retryDelay);
        } else if (typeof retryDelay !== 'function') {
            throw new ConfigurationError('retryDelay must be a non-negative integer or a function returning one');
        }

        this.operation = operation;
        this.maxAttempts = maxAttempts;
        this.shouldRetry = shouldRetry;
        this.retryDelay = retryDelay;
        this.sleep = sleep;
        this.signal = signal;
        this.clock = clock;
    }

    /**
     * Executes the operation with retries.
     *
     * Cancellation semantics:
     * - An already-aborted signal prevents the first attempt.
     * - Cancellation during retry backoff stops further attempts.
     * - If an operation completes successfully, its result wins over a
     *   concurrent abort that occurs while the operation is in flight.
     */
    async perform(): Promise<T> {
        this.ensureNotAborted();

        const startedAt = this.clock();

        for (let attemptNumber = 1; attemptNumber <= this.maxAttempts; attemptNumber++) {
            const result = await this.tryOnce();

            if (result.ok) {
                if (attemptNumber > 1) {
                    this.logRecovery(attemptNumber, attemptNumber - 1, startedAt);
                }
                return result.value;
            }

            const directive = this.determineNextAction(attemptNumber, result.error);

            if (directive.action === 'halt') {
                this.logHaltReason(directive.reason, attemptNumber, result.error, startedAt);
                throw result.error;
            }

            this.logRetrying(attemptNumber + 1, directive.delayMs, result.error, startedAt);

            try {
                await this.waitForRetry(directive.delayMs);
            } catch (error: unknown) {
                if (error instanceof CallerAbortedError) {
                    this.logHaltReason('aborted', attemptNumber, error, startedAt);
                }

                throw error;
            }
        }

        throw new Error('Invariant violated: retry loop exited without returning or throwing.');
    }

    private async tryOnce(): Promise<AttemptResult<T>> {
        try {
            const value = await this.operation.perform();
            return { ok: true, value };
        } catch (error: unknown) {
            return { ok: false, error: TrialError.normalize(error) };
        }
    }

    private determineNextAction(attemptNumber: number, error: TrialError): RetryDirective {
        if (error instanceof UnexpectedError) {
            return { action: 'halt', reason: 'unexpected' };
        }

        if (error instanceof CallerAbortedError) {
            return { action: 'halt', reason: 'aborted' };
        }

        let retry: boolean;

        try {
            retry = this.shouldRetry(error);
        } catch (cause: unknown) {
            throw TrialError.normalize(cause);
        }

        if (!retry) {
            return { action: 'halt', reason: 'not-retryable' };
        }

        if (attemptNumber >= this.maxAttempts) {
            return { action: 'halt', reason: 'exhausted' };
        }

        return {
            action: 'retry',
            delayMs: this.calculateDelay(attemptNumber - 1, error),
        };
    }

    private logHaltReason(reason: RetryHaltReason, attemptNumber: number, error: TrialError, startedAt: number): void {
        switch (reason) {
            case 'not-retryable':
                this.logNotRetryable(error, startedAt);
                break;
            case 'exhausted':
                this.logExhausted(attemptNumber, error, startedAt);
                break;
            case 'unexpected':
                this.logUnexpected(attemptNumber, error, startedAt);
                break;
            case 'aborted':
                this.logAborted(attemptNumber, error, startedAt);
                break;
        }
    }

    private ensureNotAborted(): void {
        if (this.signal?.aborted) {
            throw new CallerAbortedError('Caller aborted before first attempt.');
        }
    }

    private async waitForRetry(delayMs: number): Promise<void> {
        if (this.signal?.aborted) {
            throw new CallerAbortedError('Caller aborted before retry backoff.');
        }

        try {
            await this.sleep(delayMs, this.signal);
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
            throw new CallerAbortedError('Caller aborted after retry backoff.');
        }
    }

    private logRecovery(attemptNumber: number, retries: number, startedAt: number): void {
        logger.debug(
            {
                attempts: attemptNumber,
                retries,
                durationMs: this.clock() - startedAt,
            },
            'Operation recovered after retry',
        );
    }

    private logNotRetryable(error: TrialError, startedAt: number): void {
        logger.debug(
            {
                err: error,
                errorType: error.name,
                durationMs: this.clock() - startedAt,
            },
            'Operation failed; error is not retryable',
        );
    }

    private logExhausted(attemptNumber: number, error: TrialError, startedAt: number): void {
        logger.warn(
            {
                attempts: attemptNumber,
                maxAttempts: this.maxAttempts,
                err: error,
                errorType: error.name,
                durationMs: this.clock() - startedAt,
            },
            'Operation failed; maximum attempts reached',
        );
    }

    private logRetrying(attemptNumber: number, delayMs: number, error: TrialError, startedAt: number): void {
        logger.warn(
            {
                attempts: attemptNumber,
                maxAttempts: this.maxAttempts,
                delayMs,
                statusCode: error instanceof HttpException ? error.status : undefined,
                err: error,
                errorType: error.name,
                durationMs: this.clock() - startedAt,
            },
            'Operation failed; retrying',
        );
    }

    private logUnexpected(attemptNumber: number, error: TrialError, startedAt: number): void {
        logger.debug(
            {
                attempts: attemptNumber,
                durationMs: this.clock() - startedAt,
                err: error,
                errorType: error.name,
            },
            'Unexpected error; halting retries immediately',
        );
    }

    private logAborted(attemptNumber: number, error: TrialError, startedAt: number): void {
        logger.debug(
            {
                attempts: attemptNumber,
                durationMs: this.clock() - startedAt,
                err: error,
                errorType: error.name,
            },
            'Caller aborted; halting retries',
        );
    }

    private validateDelay(delayMs: number): void {
        if (!Number.isInteger(delayMs) || delayMs < 0) {
            throw new ConfigurationError(`delayMs must be a non-negative integer. value is ${delayMs}`);
        }
    }

    private calculateDelay(retryAttempt: number, error: TrialError): number {
        try {
            const delay =
                typeof this.retryDelay === 'function' ? this.retryDelay(retryAttempt, error) : this.retryDelay;

            this.validateDelay(delay);
            return delay;
        } catch (cause: unknown) {
            if (cause instanceof RetryDelayCalculationError) {
                throw cause;
            }
            throw new RetryDelayCalculationError(cause);
        }
    }
}
