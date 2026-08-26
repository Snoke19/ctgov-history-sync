import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
    CallerAbortedError,
    ConfigurationError,
    HttpException,
    NetworkException,
    RetryDelayCalculationError,
    TimeoutException,
    TrialError,
    UnexpectedError,
} from '../../../src/error/errors.js';
import { BusinessOperation } from '../../../src/retry/businessOperation.js';

const mockLogger = {
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.unstable_mockModule('../../../src/config/logging.js', () => ({
    createLogger: jest.fn(() => mockLogger),
}));

const { Retry } = await import('../../../src/retry/retry.js');

describe('Retry', () => {
    const retryableError = () => new HttpException('server error', 500);

    function makeOperation(perform: jest.Mock<() => Promise<string>>): BusinessOperation<string> {
        return { perform };
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('configuration', () => {
        it('stops after the first failed attempt when maxAttempts is 1', async () => {
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 1, () => true, 1, sleep).perform();

            await expect(retry).rejects.toBeInstanceOf(HttpException);

            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 1,
                    maxAttempts: 1,
                    err: expect.any(HttpException),
                    errorType: 'HttpException',
                    durationMs: expect.any(Number),
                }),
                'Operation failed; maximum attempts reached',
            );
        });

        it.each([
            ['negative', -1],
            ['zero', 0],
            ['fractional', 1.5],
            ['NaN', Number.NaN],
            ['positive Infinity', Number.POSITIVE_INFINITY],
            ['negative Infinity', Number.NEGATIVE_INFINITY],
            ['null', null],
            ['undefined', undefined],
            ['string', '3'],
            ['object', {}],
        ])('fails fast for invalid maxAttempts (%s)', (_, maxAttempts) => {
            const operation = makeOperation(jest.fn<() => Promise<string>>());

            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

            expect(() => new Retry(operation, maxAttempts as unknown as number, () => true, 1, sleep)).toThrow(
                new ConfigurationError(`maxAttempts must be a positive integer. value is ${maxAttempts}`),
            );

            expect(operation.perform).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it('runs successfully with default sleeper and default monotonic clock when omitted', async () => {
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValueOnce(retryableError()).mockResolvedValueOnce('ok'),
            );

            const retry = new Retry(operation, 2, () => true, 0);
            await expect(retry.perform()).resolves.toBe('ok');

            expect(operation.perform).toHaveBeenCalledTimes(2);
        });
    });

    describe('attempt execution', () => {
        it('returns the operation result on the first successful attempt', async () => {
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockResolvedValue('ok'));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

            const retry = new Retry(operation, 3, () => true, 1, sleep);
            const result = await retry.perform();

            expect(result).toBe('ok');
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('retries a failed attempt, waits once, and returns the eventual success', async () => {
            const error = retryableError();
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValueOnce('ok'),
            );
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, 10, sleep);
            const result = await retry.perform();

            expect(result).toBe('ok');
            expect(operation.perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledWith(10, undefined);
        });

        it('does not exceed maxAttempts when all attempts fail', async () => {
            const error = retryableError();
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBe(error);
            expect(operation.perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    attempts: 2,
                    maxAttempts: 2,
                    delayMs: 1,
                    statusCode: 500,
                    err: expect.any(HttpException),
                    errorType: 'HttpException',
                    durationMs: expect.any(Number),
                }),
                'Operation failed; retrying',
            );

            expect(mockLogger.warn).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    attempts: 2,
                    maxAttempts: 2,
                    err: expect.any(HttpException),
                    errorType: 'HttpException',
                    durationMs: expect.any(Number),
                }),
                'Operation failed; maximum attempts reached',
            );
        });

        it('throws the error from the last attempt, not the first', async () => {
            const firstError = new HttpException('first failure', 503);
            const lastError = new HttpException('last failure', 503);
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValueOnce(firstError).mockRejectedValueOnce(lastError),
            );
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, 0, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBe(lastError);
            expect(operation.perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it('does not delay after the final failed attempt', async () => {
            const error = retryableError();
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, 10, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBe(error);
            expect(operation.perform).toHaveBeenCalledTimes(3);
            expect(sleep).toHaveBeenCalledTimes(2);
        });

        it('handles synchronous exceptions thrown by operation.perform()', async () => {
            let callCount = 0;
            const operation: BusinessOperation<string> = {
                perform: () => {
                    callCount++;
                    if (callCount === 1) {
                        throw new HttpException('synchronous failure', 500);
                    }
                    return Promise.resolve('recovered');
                },
            };
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(operation, 2, () => true, 0, sleep);

            await expect(retry.perform()).resolves.toBe('recovered');
            expect(callCount).toBe(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['undefined', undefined],
            ['null', null],
            ['false', false],
            ['zero', 0],
            ['empty string', ''],
            ['empty array', []],
            ['empty object', {}],
        ])('returns valid operation result unchanged: %s', async (_, value) => {
            const operation: BusinessOperation<unknown> = {
                perform: jest
                    .fn<() => Promise<unknown>>()
                    .mockRejectedValueOnce(retryableError())
                    .mockResolvedValueOnce(value),
            };
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, 0, sleep);
            const result = await retry.perform();

            expect(result).toBe(value);
            expect(operation.perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });
    });

    describe('retry policy', () => {
        it('recovers across distinct retryable error types on successive attempts', async () => {
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(new HttpException('bad gateway', 502))
                .mockRejectedValueOnce(new NetworkException('econnreset'))
                .mockRejectedValueOnce(new TimeoutException('timed out'))
                .mockResolvedValueOnce('recovered');
            const operation = makeOperation(perform);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const shouldRetry = (error: TrialError) =>
                error instanceof HttpException ||
                error instanceof NetworkException ||
                error instanceof TimeoutException;

            const retry = new Retry(operation, 4, shouldRetry, 10, sleep);
            const result = await retry.perform();

            expect(result).toBe('recovered');
            expect(perform).toHaveBeenCalledTimes(4);
            expect(sleep).toHaveBeenCalledTimes(3);
        });

        it('calls shouldRetry with the normalized error so instanceof predicates work', async () => {
            const httpError = new HttpException('service unavailable', 503);
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(httpError)
                .mockResolvedValueOnce('ok');
            const operation = makeOperation(perform);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const shouldRetry = jest
                .fn<(error: TrialError) => boolean>()
                .mockImplementation((error) => error instanceof HttpException && error.status === 503);

            const retry = new Retry(operation, 2, shouldRetry, 0, sleep);
            const result = await retry.perform();

            expect(result).toBe('ok');
            expect(shouldRetry).toHaveBeenCalledTimes(1);

            const receivedError = shouldRetry.mock.calls[0]![0];
            expect(receivedError).toBe(httpError);
            expect(receivedError).toBeInstanceOf(HttpException);
            expect((receivedError as HttpException).status).toBe(503);
            expect(perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it('does not retry when shouldRetry returns false', async () => {
            const error = retryableError();
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => false, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBe(error);
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('retries when shouldRetry returns true', async () => {
            const error = retryableError();
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce('success');
            const operation = makeOperation(perform);
            const shouldRetry = jest.fn<(error: TrialError) => boolean>().mockReturnValue(true);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, shouldRetry, 0, sleep);
            const result = await retry.perform();

            expect(result).toBe('success');
            expect(perform).toHaveBeenCalledTimes(2);
            expect(shouldRetry).toHaveBeenCalledTimes(1);
            expect(shouldRetry).toHaveBeenCalledWith(error);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it('stops retrying when shouldRetry returns false on a later attempt', async () => {
            const firstError = new HttpException('server error', 503);
            const secondError = new HttpException('not found', 404);
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(firstError)
                .mockRejectedValueOnce(secondError);
            const operation = makeOperation(perform);
            const shouldRetry = jest
                .fn<(error: TrialError) => boolean>()
                .mockReturnValueOnce(true)
                .mockReturnValueOnce(false);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 5, shouldRetry, 0, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBe(secondError);
            expect(perform).toHaveBeenCalledTimes(2);
            expect(shouldRetry).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
            expect(shouldRetry).toHaveBeenNthCalledWith(1, firstError);
            expect(shouldRetry).toHaveBeenNthCalledWith(2, secondError);
        });

        it('normalizes a shouldRetry exception immediately without retrying', async () => {
            const predicateError = new Error('shouldRetry exploded');
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const shouldRetry = jest.fn<(error: TrialError) => boolean>().mockImplementation(() => {
                throw predicateError;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, shouldRetry, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(UnexpectedError);

            const error = await result.catch((error) => error);

            expect(error).toBeInstanceOf(UnexpectedError);
            expect(error.message).toBe('Unexpected error: shouldRetry exploded');
            expect(error.cause).toBe(predicateError);

            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(shouldRetry).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('normalizes a shouldRetry exception on a later retry attempt', async () => {
            const firstError = retryableError();
            const predicateError = new Error('shouldRetry exploded on second attempt');
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(firstError)
                .mockRejectedValueOnce(retryableError());
            const operation = makeOperation(perform);
            const shouldRetry = jest
                .fn<(error: TrialError) => boolean>()
                .mockReturnValueOnce(true)
                .mockImplementationOnce(() => {
                    throw predicateError;
                });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, shouldRetry, 0, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(UnexpectedError);

            const error = await result.catch((error) => error);

            expect(error).toBeInstanceOf(UnexpectedError);
            expect(error.message).toBe('Unexpected error: shouldRetry exploded on second attempt');
            expect(error.cause).toBe(predicateError);

            expect(perform).toHaveBeenCalledTimes(2);
            expect(shouldRetry).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });
    });

    describe('error handling', () => {
        it('halts without calling shouldRetry when operation throws an UnexpectedError', async () => {
            const boom = new Error('boom');
            const shouldRetry = jest.fn<(error: TrialError) => boolean>().mockReturnValue(true);
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(boom));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, shouldRetry, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'UnexpectedError',
                message: 'Unexpected error: boom',
                cause: boom,
            });
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(shouldRetry).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['number', 42],
            ['object', { message: 'custom' }],
        ])('normalizes non-TrialError rejection to UnexpectedError: %s', async (_, rawError) => {
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(rawError));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, 0, sleep);
            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'UnexpectedError',
            });
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('normalizes a synchronous non-Error throw to UnexpectedError', async () => {
            const rawError = new Error('sync raw string');
            const operation: BusinessOperation<string> = {
                perform: () => {
                    throw rawError;
                },
            };
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, 0, sleep);
            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'UnexpectedError',
                message: 'Unexpected error: sync raw string',
                cause: rawError,
            });

            expect(sleep).not.toHaveBeenCalled();
        });

        it('preserves a known error and its cause when retries are exhausted', async () => {
            const cause = new Error('root cause');
            const error = new HttpException('server error', 500, undefined, { cause });
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBe(error);
            await expect(result).rejects.toMatchObject({ cause });
            expect(operation.perform).toHaveBeenCalledTimes(3);
            expect(sleep).toHaveBeenCalledTimes(2);
        });

        it('normalizes a non-TrialError immediately without retrying', async () => {
            const boom = new Error('boom');
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(boom));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'UnexpectedError',
                cause: boom,
            });
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('normalizes a sleep rejection when the signal is not aborted', async () => {
            const sleepError = new Error('sleep boom');
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockRejectedValue(sleepError);

            const retry = new Retry(operation, 2, () => true, 1, sleep);
            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'UnexpectedError',
                cause: sleepError,
            });
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledTimes(1);
        });
    });

    describe('cancellation', () => {
        it('does not invoke shouldRetry when operation throws CallerAbortedError', async () => {
            const abortError = new CallerAbortedError('Aborted by client');
            const perform = jest.fn<() => Promise<string>>().mockRejectedValue(abortError);
            const shouldRetryMock = jest.fn<(err: TrialError) => boolean>().mockReturnValue(true);
            const retry = new Retry(makeOperation(perform), 3, shouldRetryMock, 0);

            await expect(retry.perform()).rejects.toBe(abortError);
            expect(shouldRetryMock).not.toHaveBeenCalled();
        });

        it('returns successful result when caller aborts after operation completes', async () => {
            const controller = new AbortController();
            const perform = jest.fn<() => Promise<string>>().mockImplementation(async () => {
                // Simulate the caller aborting while the operation is in-flight
                controller.abort();
                return 'ok';
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const clock = jest.fn<() => number>().mockReturnValue(0);

            const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep, controller.signal, clock);

            // Intentional: perform() does not re-check the signal after tryOnce() resolves.
            // If the operation succeeded, we return the value regardless of subsequent abort.
            await expect(retry.perform()).resolves.toBe('ok');

            expect(perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        it('throws CallerAbortedError without running the operation when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const promiseRetry = new Retry(operation, 2, () => true, 1, sleep, controller.signal).perform();
            const error = await promiseRetry.catch((e) => e);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error.message).toBe('Caller aborted before first attempt.');
            expect(operation.perform).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it('throws CallerAbortedError when sleep rejects after signal aborts', async () => {
            const controller = new AbortController();
            const sleepError = new Error('sleep interrupted by OS');
            const sleep = jest
                .fn<(ms: number, signal?: AbortSignal) => Promise<void>>()
                .mockImplementation(async () => {
                    controller.abort();
                    throw sleepError;
                });

            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const promiseRetry = new Retry(operation, 2, () => true, 1, sleep, controller.signal).perform();
            const error = await promiseRetry.catch((e) => e);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error.message).toBe('The retry backoff was aborted by the caller.');
            await expect(promiseRetry).rejects.toMatchObject({ cause: sleepError });

            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it('throws CallerAbortedError when the caller aborts while computing the delay', async () => {
            const controller = new AbortController();

            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation(() => {
                controller.abort();
                return 1;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const promiseRetry = new Retry(operation, 2, () => true, retryDelay, sleep, controller.signal).perform();
            const error = await promiseRetry.catch((e) => e);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error.message).toBe('Caller aborted before retry backoff.');

            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(retryDelay).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it('throws CallerAbortedError when a custom sleeper resolves despite an aborted signal', async () => {
            const retryError = retryableError();
            const perform = jest.fn<() => Promise<string>>().mockRejectedValueOnce(retryError);

            const controller = new AbortController();
            // Non-conforming sleeper: aborts the signal but resolves anyway
            const sleep = jest
                .fn<(ms: number, signal?: AbortSignal) => Promise<void>>()
                .mockImplementation(async () => {
                    controller.abort();
                    return undefined;
                });

            const clock = jest.fn<() => number>().mockReturnValue(0);

            const promiseRetry = new Retry(
                makeOperation(perform),
                2,
                () => true,
                0,
                sleep,
                controller.signal,
                clock,
            ).perform();
            const error = await promiseRetry.catch((e) => e);

            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error.message).toBe('Caller aborted after retry backoff.');

            expect(perform).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledWith(0, controller.signal);
        });

        it('halts immediately with CallerAbortedError before sleeping when signal aborts during a failed attempt', async () => {
            const controller = new AbortController();
            const perform = jest.fn<() => Promise<string>>().mockImplementation(async () => {
                controller.abort();
                throw new HttpException('server error', 500);
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(makeOperation(perform), 3, () => true, 100, sleep, controller.signal);

            const error = await retry.perform().catch((e) => e);
            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error.message).toBe('Caller aborted before retry backoff.');
            expect(sleep).not.toHaveBeenCalled();
        });

        it('aborts on second attempt after successful first retry delay', async () => {
            const controller = new AbortController();
            let attemptCount = 0;
            const perform = jest.fn<() => Promise<string>>().mockImplementation(async () => {
                attemptCount++;
                if (attemptCount === 2) {
                    controller.abort();
                    throw new HttpException('server error 2', 500);
                }
                throw new HttpException('server error 1', 500);
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(makeOperation(perform), 3, () => true, 10, sleep, controller.signal);

            const error = await retry.perform().catch((e) => e);
            expect(error).toBeInstanceOf(CallerAbortedError);
            expect(error.message).toBe('Caller aborted before retry backoff.');
            expect(perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        });
    });

    describe('delay and backoff', () => {
        it('uses exponential backoff delays between retries', async () => {
            const error = retryableError();
            const operation = makeOperation(
                jest
                    .fn<() => Promise<string>>()
                    .mockRejectedValueOnce(error)
                    .mockRejectedValueOnce(error)
                    .mockResolvedValueOnce('ok'),
            );
            const delay = (attempt: number): number => 100 * 2 ** attempt;
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, delay, sleep);
            const result = await retry.perform();

            expect(result).toBe('ok');
            expect(operation.perform).toHaveBeenCalledTimes(3);
            expect(sleep).toHaveBeenNthCalledWith(1, 100, undefined);
            expect(sleep).toHaveBeenNthCalledWith(2, 200, undefined);
        });

        it('passes the zero-indexed retry number and failed error to the delay function', async () => {
            const error = retryableError();
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValueOnce('ok'),
            );
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(25);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, retryDelay, sleep);
            const result = await retry.perform();

            expect(result).toBe('ok');
            expect(retryDelay).toHaveBeenCalledWith(0, error);
            expect(sleep).toHaveBeenCalledWith(25, undefined);
        });

        it('propagates exception thrown by delayMs function immediately', async () => {
            const delayError = new Error('delay calc failure');
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation(() => {
                throw delayError;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, retryDelay, sleep);
            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'RetryDelayCalculationError',
                message: 'Failed to calculate retry delay: delay calc failure',
                cause: delayError,
            });
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(retryDelay).toHaveBeenCalledWith(0, expect.any(HttpException));
            expect(sleep).not.toHaveBeenCalled();
        });

        it.each([
            ['negative', -1],
            ['negative', -100],
            ['fractional', 1.5],
            ['fractional', 12.345],
            ['NaN', Number.NaN],
            ['positive Infinity', Number.POSITIVE_INFINITY],
            ['negative Infinity', Number.NEGATIVE_INFINITY],
        ])('fails fast for invalid static retryDelay (%s)', (_, retryDelay) => {
            const operation = makeOperation(jest.fn<() => Promise<string>>());
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

            expect(() => new Retry(operation, 3, () => true, retryDelay, sleep)).toThrow(
                new ConfigurationError(`delayMs must be a non-negative integer. value is ${retryDelay}`),
            );

            expect(operation.perform).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it.each([
            ['negative', -1],
            ['fractional', 1.5],
            ['NaN', Number.NaN],
            ['positive Infinity', Number.POSITIVE_INFINITY],
            ['negative Infinity', Number.NEGATIVE_INFINITY],
        ])('rejects invalid delay returned by callback (%s)', async (_, delayMs) => {
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(delayMs);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(operation, 2, () => true, retryDelay, sleep);

            const result = retry.perform();

            await expect(result).rejects.toMatchObject({
                name: 'RetryDelayCalculationError',
                cause: expect.objectContaining({
                    name: 'ConfigurationError',
                    message: `delayMs must be a non-negative integer. value is ${delayMs}`,
                }),
            });

            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(retryDelay).toHaveBeenCalledWith(0, expect.any(HttpException));
            expect(sleep).not.toHaveBeenCalled();
        });

        it('passes the correct retry index and error to the delay function on each retry', async () => {
            const firstError = new HttpException('first failure', 500);
            const secondError = new HttpException('second failure', 503);

            const operation = makeOperation(
                jest
                    .fn<() => Promise<string>>()
                    .mockRejectedValueOnce(firstError)
                    .mockRejectedValueOnce(secondError)
                    .mockResolvedValueOnce('ok'),
            );
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(25);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 3, () => true, retryDelay, sleep);

            await expect(retry.perform()).resolves.toBe('ok');
            expect(retryDelay).toHaveBeenNthCalledWith(1, 0, firstError);
            expect(retryDelay).toHaveBeenNthCalledWith(2, 1, secondError);
            expect(sleep).toHaveBeenNthCalledWith(1, 25, undefined);
            expect(sleep).toHaveBeenNthCalledWith(2, 25, undefined);
        });
    });

    describe('state isolation', () => {
        it('captures maxAttempts at construction time', async () => {
            const config = {
                maxAttempts: 3,
            };
            const error = retryableError();
            const perform = jest.fn<() => Promise<string>>().mockRejectedValue(error);
            const operation = makeOperation(perform);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(operation, config.maxAttempts, () => true, 10, sleep);

            config.maxAttempts = 1;

            await expect(retry.perform()).rejects.toBe(error);

            expect(operation.perform).toHaveBeenCalledTimes(3);
            expect(sleep).toHaveBeenCalledTimes(2);
        });

        it('resets retry state for each perform invocation', async () => {
            const error = retryableError();
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce('ok')
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce('ok');
            const operation = makeOperation(perform);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, 10, sleep);

            await expect(retry.perform()).resolves.toBe('ok');
            await expect(retry.perform()).resolves.toBe('ok');

            expect(perform).toHaveBeenCalledTimes(4);
            expect(sleep).toHaveBeenCalledTimes(2);
        });

        it('keeps concurrent perform invocations independent during overlapping retries', async () => {
            const firstError = new HttpException('first call failure', 503);
            const secondError = new HttpException('second call failure', 503);

            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(firstError)
                .mockRejectedValueOnce(secondError)
                .mockResolvedValueOnce('first recovered')
                .mockResolvedValueOnce('second recovered');

            const delayAttempts: number[] = [];
            const delayErrors: TrialError[] = [];

            const delay = jest
                .fn<(attempt: number, error: TrialError) => number>()
                .mockImplementation((attempt, error) => {
                    delayAttempts.push(attempt);
                    delayErrors.push(error);
                    return 10;
                });

            const sleepResolvers: Array<() => void> = [];

            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockImplementation(
                () =>
                    new Promise<void>((resolve) => {
                        sleepResolvers.push(resolve);
                    }),
            );

            const retry = new Retry(makeOperation(perform), 2, () => true, delay, sleep);

            const first = retry.perform();
            const second = retry.perform();

            // Let both executions reach their retry delay.
            await Promise.resolve();
            await Promise.resolve();

            expect(perform).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(2);

            // Both executions must start their own retry sequence at attempt 0.
            expect(delayAttempts).toEqual([0, 0]);
            expect(delayErrors).toEqual([firstError, secondError]);

            // Release the first retry.
            sleepResolvers[0]!();

            await expect(first).resolves.toBe('first recovered');

            // The second execution is still blocked in its own backoff.
            expect(perform).toHaveBeenCalledTimes(3);

            // Release the second retry.
            sleepResolvers[1]!();

            await expect(second).resolves.toBe('second recovered');

            expect(perform).toHaveBeenCalledTimes(4);
            expect(sleep).toHaveBeenCalledTimes(2);
        });

        it('does not accumulate execution state across repeated retry cycles', async () => {
            const perform = jest.fn<() => Promise<string>>();
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep);

            for (let i = 0; i < 100; i++) {
                perform.mockRejectedValueOnce(new HttpException(`error ${i}`, 500)).mockResolvedValueOnce('ok');
                await expect(retry.perform()).resolves.toBe('ok');
            }

            expect(perform).toHaveBeenCalledTimes(200);
        });
    });

    describe('logging', () => {
        it('logs exhausted when final attempt error is retryable', async () => {
            const error = new HttpException('gateway', 504);
            const perform = jest.fn<() => Promise<string>>().mockRejectedValue(error);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep);

            await expect(retry.perform()).rejects.toBe(error);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ attempts: 2, maxAttempts: 2, durationMs: expect.any(Number) }),
                'Operation failed; maximum attempts reached',
            );
        });

        it('logs not-retryable when shouldRetry returns false', async () => {
            const error = new HttpException('not found', 404);
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(new HttpException('gateway', 504))
                .mockRejectedValueOnce(error);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const shouldRetry = (err: TrialError) => err instanceof HttpException && err.status === 504;

            const retry = new Retry(makeOperation(perform), 2, shouldRetry, 0, sleep);
            await expect(retry.perform()).rejects.toBe(error);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: error,
                    errorType: 'HttpException',
                    durationMs: expect.any(Number),
                }),
                'Operation failed; error is not retryable',
            );
        });

        it('logs recovery with the correct retry count after multiple retries', async () => {
            const error = retryableError();

            const operation = makeOperation(
                jest
                    .fn<() => Promise<string>>()
                    .mockRejectedValueOnce(error)
                    .mockRejectedValueOnce(error)
                    .mockResolvedValueOnce('ok'),
            );

            await new Retry(operation, 3, () => true, 0).perform();

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 3,
                    retries: 2,
                    durationMs: expect.any(Number),
                }),
                'Operation recovered after retry',
            );

            expect(mockLogger.warn).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    attempts: 2,
                    maxAttempts: 3,
                    delayMs: 0,
                    err: error,
                    errorType: 'HttpException',
                    statusCode: 500,
                    durationMs: expect.any(Number),
                }),
                'Operation failed; retrying',
            );

            expect(mockLogger.warn).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    attempts: 3,
                    maxAttempts: 3,
                    delayMs: 0,
                    err: error,
                    errorType: 'HttpException',
                    statusCode: 500,
                    durationMs: expect.any(Number),
                }),
                'Operation failed; retrying',
            );
        });

        it('uses the injected monotonic clock for duration logging', async () => {
            const error = retryableError();
            const perform = jest.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const clock = jest
                .fn<() => number>()
                .mockReturnValueOnce(100)
                .mockReturnValueOnce(250)
                .mockReturnValueOnce(400);

            const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep, undefined, clock);
            await expect(retry.perform()).resolves.toBe('ok');

            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 2,
                    retries: 1,
                    durationMs: 300,
                }),
                'Operation recovered after retry',
            );

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 2,
                    maxAttempts: 2,
                    delayMs: 0,
                    err: error,
                    errorType: 'HttpException',
                    statusCode: 500,
                    durationMs: 150,
                }),
                'Operation failed; retrying',
            );
        });

        it('logs unexpected errors without retrying', async () => {
            const unexpectedError = new UnexpectedError('database corruption detected');
            const perform = jest.fn<() => Promise<string>>().mockRejectedValueOnce(unexpectedError);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const clock = jest.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(1000);

            const retry = new Retry(makeOperation(perform), 3, () => true, 1000, sleep, undefined, clock);

            await expect(retry.perform()).rejects.toBe(unexpectedError);

            expect(perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 1,
                    durationMs: 0,
                    err: unexpectedError,
                    errorType: 'UnexpectedError',
                }),
                'Unexpected error; halting retries immediately',
            );
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('logs caller aborts without retrying', async () => {
            const abortError = new CallerAbortedError('The operation was aborted');
            const perform = jest.fn<() => Promise<string>>().mockRejectedValueOnce(abortError);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const clock = jest.fn<() => number>().mockReturnValueOnce(500).mockReturnValueOnce(500);

            const retry = new Retry(makeOperation(perform), 3, () => true, 1000, sleep, undefined, clock);

            await expect(retry.perform()).rejects.toThrow('The operation was aborted');

            expect(perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 1,
                    durationMs: 0,
                    err: abortError,
                    errorType: 'CallerAbortedError',
                }),
                'Caller aborted; halting retries',
            );
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        it('logs retry warning with undefined statusCode for NetworkException', async () => {
            const netError = new NetworkException('connection refused');
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(netError)
                .mockResolvedValueOnce('ok');
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep);

            await expect(retry.perform()).resolves.toBe('ok');
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempts: 2,
                    maxAttempts: 2,
                    delayMs: 0,
                    statusCode: undefined,
                    err: netError,
                    errorType: 'NetworkException',
                    durationMs: expect.any(Number),
                }),
                'Operation failed; retrying',
            );
        });
    });

    describe('execution state isolation', () => {
        it('starts clean after an exhausted retry cycle', async () => {
            const error = new HttpException('failure', 500);
            const perform = jest.fn<() => Promise<string>>().mockRejectedValue(error);
            const retry = new Retry(makeOperation(perform), 2, () => true, 0);

            await expect(retry.perform()).rejects.toBe(error);

            perform.mockReset();
            perform.mockResolvedValue('recovered');

            await expect(retry.perform()).resolves.toBe('recovered');
            expect(perform).toHaveBeenCalledTimes(1);
        });

        it('does not leak retry counters between concurrent executions', async () => {
            const perform = jest.fn(async () => {
                throw new HttpException('failure', 500);
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep);
            const results = await Promise.allSettled([retry.perform(), retry.perform()]);

            expect(sleep).toHaveBeenCalledTimes(2);
            expect(results).toHaveLength(2);
            expect(results).toEqual([
                expect.objectContaining({
                    status: 'rejected',
                    reason: expect.any(HttpException),
                }),
                expect.objectContaining({
                    status: 'rejected',
                    reason: expect.any(HttpException),
                }),
            ]);
            expect(perform).toHaveBeenCalledTimes(4);
        });
    });

    describe('cancellation during retry backoff', () => {
        it('does not execute another attempt after cancellation during backoff', async () => {
            const controller = new AbortController();
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(new HttpException('server error', 500))
                .mockResolvedValueOnce('should not run');
            const sleep = jest
                .fn<(ms: number, signal?: AbortSignal) => Promise<void>>()
                .mockImplementation(async () => {
                    controller.abort();
                });

            const retry = new Retry(makeOperation(perform), 2, () => true, 10, sleep, controller.signal);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(CallerAbortedError);
            expect(perform).toHaveBeenCalledTimes(1);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it('requires cancellation during backoff to be logged as an aborted retry', async () => {
            const controller = new AbortController();
            const retryError = new HttpException('server error', 500);
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryError));
            const sleep = jest
                .fn<(ms: number, signal?: AbortSignal) => Promise<void>>()
                .mockImplementation(async () => {
                    controller.abort();
                    throw new Error('sleep interrupted');
                });

            const retry = new Retry(operation, 2, () => true, 10, sleep, controller.signal);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(CallerAbortedError);

            // This assertion defines the intended observability contract.
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: expect.any(CallerAbortedError),
                    errorType: 'CallerAbortedError',
                }),
                'Caller aborted; halting retries',
            );
        });
    });

    describe('dynamic delay calculation', () => {
        it('passes zero-based retry attempt and the failed error to the delay function', async () => {
            const firstError = new HttpException('first failure', 503);
            const secondError = new HttpException('second failure', 502);
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(firstError)
                .mockRejectedValueOnce(secondError)
                .mockResolvedValueOnce('ok');
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(0);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(makeOperation(perform), 3, () => true, retryDelay, sleep);

            await expect(retry.perform()).resolves.toBe('ok');
            expect(retryDelay).toHaveBeenNthCalledWith(1, 0, firstError);
            expect(retryDelay).toHaveBeenNthCalledWith(2, 1, secondError);
            expect(retryDelay).toHaveBeenCalledTimes(2);
        });

        it('wraps a delay callback exception in RetryDelayCalculationError', async () => {
            const callbackError = new Error('delay calculation failed');
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValue(new HttpException('server error', 500)),
            );
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation(() => {
                throw callbackError;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, retryDelay, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(RetryDelayCalculationError);
            await expect(result).rejects.toMatchObject({ cause: callbackError });
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });

        it.each([
            ['negative', -1],
            ['fractional', 1.5],
            ['NaN', Number.NaN],
            ['positive Infinity', Number.POSITIVE_INFINITY],
            ['negative Infinity', Number.NEGATIVE_INFINITY],
        ])('wraps an invalid delay callback result in RetryDelayCalculationError: %s', async (_, value) => {
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValue(new HttpException('server error', 500)),
            );
            const retryDelay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(value);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, retryDelay, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(RetryDelayCalculationError);
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });
    });
});
