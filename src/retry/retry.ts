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

type DelayMs = number | ((retryAttempt: number, error: TrialError) => number);
type AttemptResult<T> = { ok: true; value: T } | { ok: false; error: TrialError };
type RetryDirective =
    | { action: 'retry'; delayMs: number }
    | { action: 'halt'; reason: 'unexpected' | 'aborted' | 'not-retryable' | 'exhausted' };

export class Retry<T> implements BusinessOperation<T> {
    private readonly operation: BusinessOperation<T>;
    private readonly maxAttempts: number;
    private readonly shouldRetry: (error: TrialError) => boolean;
    private readonly delayMs: DelayMs;
    private readonly sleep: Sleeper['sleep'];
    private readonly signal: AbortSignal | undefined;
    private readonly clock: MonotonicClock['now'];

    constructor(
        operation: BusinessOperation<T>,
        maxAttempts: number,
        shouldRetry: (error: TrialError) => boolean,
        delayMs: DelayMs,
        sleep: Sleeper['sleep'] = defaultSleeper.sleep,
        signal?: AbortSignal,
        clock: MonotonicClock['now'] = defaultMonotonicClock.now,
    ) {
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
            throw new ConfigurationError(`maxAttempts must be a positive integer. value is ${maxAttempts}`);
        }

        if (typeof delayMs === 'number') {
            this.validateDelay(delayMs);
        } else if (typeof delayMs !== 'function') {
            throw new ConfigurationError('delayMs must be a non-negative integer or a function returning one');
        }

        this.operation = operation;
        this.maxAttempts = maxAttempts;
        this.shouldRetry = shouldRetry;
        this.delayMs = delayMs;
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

        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const result = await this.tryOnce();

            if (result.ok) {
                if (attempt > 1) {
                    this.logRecovery(attempt, attempt - 1, startedAt);
                }
                return result.value;
            }

            const directive = this.determineNextAction(attempt, result.error);

            if (directive.action === 'halt') {
                this.logHaltReason(directive.reason, attempt, result.error, startedAt);
                throw result.error;
            }

            this.logRetrying(attempt + 1, directive.delayMs, result.error);

            try {
                await this.delayWithAbortCheck(directive.delayMs);
            } catch (error: unknown) {
                if (error instanceof CallerAbortedError) {
                    this.logHaltReason('aborted', attempt, error, startedAt);
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

    private determineNextAction(currentAttempt: number, error: TrialError): RetryDirective {
        if (error instanceof UnexpectedError) {
            return { action: 'halt', reason: 'unexpected' };
        }

        if (error instanceof CallerAbortedError) {
            return { action: 'halt', reason: 'aborted' };
        }

        if (!this.shouldRetry(error)) {
            return { action: 'halt', reason: 'not-retryable' };
        }

        if (currentAttempt >= this.maxAttempts) {
            return { action: 'halt', reason: 'exhausted' };
        }

        const delayMs = this.resolveDelay(currentAttempt - 1, error);

        return { action: 'retry', delayMs };
    }

    private logHaltReason(
        reason: 'unexpected' | 'aborted' | 'not-retryable' | 'exhausted',
        attempt: number,
        error: TrialError,
        startedAt: number,
    ): void {
        switch (reason) {
            case 'not-retryable':
                this.logNotRetryable(error);
                break;
            case 'exhausted':
                this.logExhausted(attempt, error, startedAt);
                break;
            case 'unexpected':
                this.logUnexpected(attempt, error, startedAt);
                break;
            case 'aborted':
                this.logAborted(attempt, error, startedAt);
                break;
        }
    }

    private ensureNotAborted(): void {
        if (this.signal?.aborted) {
            throw new CallerAbortedError('Caller aborted before first attempt.');
        }
    }

    private async delayWithAbortCheck(ms: number): Promise<void> {
        if (this.signal?.aborted) {
            throw new CallerAbortedError('Caller aborted before retry backoff.');
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
            throw new CallerAbortedError('Caller aborted after retry backoff.');
        }
    }

    private logRecovery(attempt: number, retries: number, startedAt: number): void {
        logger.debug(
            {
                attempts: attempt,
                retries,
                durationMs: this.clock() - startedAt,
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
                durationMs: this.clock() - startedAt,
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
                statusCode: error instanceof HttpException ? error.status : undefined,
                err: error,
                errorType: error.name,
            },
            'Operation failed; retrying',
        );
    }

    private logUnexpected(attempt: number, error: TrialError, startedAt: number): void {
        logger.debug(
            {
                attempts: attempt,
                durationMs: this.clock() - startedAt,
                err: error,
                errorType: error.name,
            },
            'Unexpected error; halting retries immediately',
        );
    }

    private logAborted(attempt: number, error: TrialError, startedAt: number): void {
        logger.debug(
            {
                attempts: attempt,
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

    private resolveDelay(currentAttempt: number, error: TrialError): number {
        let raw: number;

        try {
            raw = typeof this.delayMs === 'function' ? this.delayMs(currentAttempt, error) : this.delayMs;

            this.validateDelay(raw);
        } catch (cause: unknown) {
            if (cause instanceof RetryDelayCalculationError) {
                throw cause;
            }

            throw new RetryDelayCalculationError(cause);
        }

        return raw;
    }
}
