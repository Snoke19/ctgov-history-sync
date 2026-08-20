import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError, HttpException, TrialError, UnexpectedError } from '../../../src/error/errors.js';
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

    it('accepts maxAttempts: 1', async () => {
        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        await expect(new Retry(operation, 1, () => true, 1, sleep).perform()).rejects.toBeInstanceOf(HttpException);

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

    it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maxAttempts: %s', (maxAttempts) => {
        const operation = makeOperation(jest.fn<() => Promise<string>>());
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

        expect(() => new Retry(operation, maxAttempts, () => true, 1, sleep)).toThrow(
            `maxAttempts must be a positive integer. value is ${maxAttempts}`,
        );
    });

    it('does not exceed maxAttempts when all attempts fail', async () => {
        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        await expect(new Retry(operation, 2, () => true, 1, sleep).perform()).rejects.toBeInstanceOf(HttpException);

        expect(operation.perform).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);

        expect(mockLogger.warn).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                attempt: 2,
                maxAttempts: 2,
                delayMs: 1,
                reason: 'HttpException',
                statusCode: 500,
                err: expect.any(HttpException),
                errorType: 'HttpException',
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

    describe('retry-ability predicate', () => {
        it('does not retry when shouldRetry returns false', async () => {
            const error = retryableError();
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const promise = new Retry(operation, 3, () => false, 1, sleep).perform();

            await expect(promise).rejects.toBe(error);
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();

            expect(mockLogger.debug).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    err: expect.any(HttpException),
                    errorType: 'HttpException',
                }),
                'Operation failed; error is not retryable',
            );
        });

        it('retries only when shouldRetry returns true for the error', async () => {
            const error = retryableError();

            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(error)
                .mockResolvedValueOnce('success');

            const operation: BusinessOperation<string> = { perform };

            const shouldRetry = jest.fn<(error: TrialError) => boolean>().mockReturnValue(true);

            const retry = new Retry(operation, 3, shouldRetry, 0);

            await expect(retry.perform()).resolves.toBe('success');

            expect(perform).toHaveBeenCalledTimes(2);
            expect(shouldRetry).toHaveBeenCalledTimes(1);
            expect(shouldRetry).toHaveBeenCalledWith(expect.any(TrialError));
        });

        it('does not call shouldRetry for UnexpectedError', async () => {
            const boom = new Error('boom');
            const shouldRetry = jest.fn<(error: TrialError) => boolean>().mockReturnValue(true);
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(boom));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            await expect(new Retry(operation, 3, shouldRetry, 1, sleep).perform()).rejects.toBeInstanceOf(
                UnexpectedError,
            );

            expect(shouldRetry).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it('propagates a shouldRetry exception immediately without retrying', async () => {
            const predicateError = new Error('shouldRetry exploded');
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const promise = new Retry(
                operation,
                3,
                () => {
                    throw predicateError;
                },
                1,
                sleep,
            ).perform();

            await expect(promise).rejects.toBe(predicateError);
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });
    });

    describe('cancellation via AbortSignal', () => {
        it('throws CallerAbortedError without running the operation when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const promise = new Retry(operation, 2, () => true, 1, sleep, controller.signal).perform();

            await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
            // Pre-flight check fires before the first attempt
            expect(operation.perform).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        });

        it('throws CallerAbortedError when the signal aborts during the backoff wait', async () => {
            const controller = new AbortController();
            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
            const sleep = jest
                .fn<(ms: number, signal?: AbortSignal) => Promise<void>>()
                .mockImplementation(async () => {
                    controller.abort();
                });

            const promise = new Retry(operation, 2, () => true, 1, sleep, controller.signal).perform();

            await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
            expect(sleep).toHaveBeenCalledTimes(1);
        });

        it('throws CallerAbortedError when the caller aborts while computing the delay', async () => {
            const controller = new AbortController();

            const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));

            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation(() => {
                controller.abort();
                return 1;
            });

            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const promise = new Retry(operation, 2, () => true, delay, sleep, controller.signal).perform();

            await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);

            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(delay).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });
    });

    it('preserves the original error and cause when retries are exhausted', async () => {
        const cause = new Error('root cause');
        const error = new HttpException('server error', 500, undefined, { cause });

        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const retry = new Retry(operation, 3, () => true, 1, sleep);
        const promise = retry.perform();

        await expect(promise).rejects.toBe(error);
        await expect(promise).rejects.toMatchObject({ cause });

        expect(operation.perform).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    describe('delay', () => {
        it('uses exponential backoff delays between retries', async () => {
            const error = retryableError();

            const operation = makeOperation(
                jest
                    .fn<() => Promise<string>>()
                    .mockRejectedValueOnce(error)
                    .mockRejectedValueOnce(error)
                    .mockResolvedValueOnce('ok'),
            );

            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
            const delay = (attempt: number): number => 100 * 2 ** attempt;

            const result = await new Retry(operation, 3, () => true, delay, sleep).perform();

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
            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(25);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const result = await new Retry(operation, 2, () => true, delay, sleep).perform();

            expect(result).toBe('ok');
            expect(delay).toHaveBeenCalledWith(0, error);
            expect(sleep).toHaveBeenCalledWith(25, undefined);
        });

        it('waits at least 0 ms even when the computed delay is negative', async () => {
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValueOnce(retryableError()).mockResolvedValueOnce('ok'),
            );
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            await new Retry(operation, 2, () => true, -100, sleep).perform();

            expect(sleep).toHaveBeenCalledWith(0, undefined);
        });
    });

    it('returns the operation result on the first successful attempt', async () => {
        const operation = makeOperation(jest.fn<() => Promise<string>>().mockResolvedValue('ok'));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

        const result = await new Retry(operation, 3, () => true, 1, sleep).perform();

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

        const result = await new Retry(operation, 2, () => true, 10, sleep).perform();

        expect(result).toBe('ok');
        expect(operation.perform).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(10, undefined);
    });

    it('logs recovery with attempt count, retry count, and elapsed time after eventual success', async () => {
        const error = retryableError();

        const operation = makeOperation(
            jest.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValueOnce('ok'),
        );

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        await new Retry(operation, 2, () => true, 0, sleep).perform();

        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({
                attempts: 2,
                retries: 1,
                durationMs: expect.any(Number),
            }),
            'Operation recovered after retry',
        );
    });

    it('does not delay after the final failed attempt', async () => {
        const error = retryableError();

        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const retry = new Retry(operation, 3, () => true, 10, sleep);
        await expect(retry.perform()).rejects.toBe(error);

        expect(operation.perform).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('propagates asynchronous attempt failures without an unhandled rejection', async () => {
        const error = retryableError();

        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(error));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        await expect(new Retry(operation, 1, () => true, 10, sleep).perform()).rejects.toBe(error);

        expect(operation.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('normalizes a non-TrialError immediately without retrying', async () => {
        const boom = new Error('boom');
        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(boom));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
        const promise = new Retry(operation, 3, () => true, 1, sleep).perform();

        await expect(promise).rejects.toBeInstanceOf(UnexpectedError);
        await expect(promise).rejects.toMatchObject({ cause: boom });

        expect(operation.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('normalizes a sleep rejection when the signal is not aborted', async () => {
        const sleepError = new Error('sleep boom');
        const operation = makeOperation(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockRejectedValue(sleepError);
        const promise = new Retry(operation, 2, () => true, 1, sleep).perform();

        await expect(promise).rejects.toBeInstanceOf(UnexpectedError);
        await expect(promise).rejects.toMatchObject({ cause: sleepError });

        expect(operation.perform).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(1);
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

    it('keeps concurrent perform invocations independent', async () => {
        const error = retryableError();
        const delayAttempts: number[] = [];

        // Both invocations start before either awaits, so they interleave through
        // the microtask queue. Mock queue order: [fail, fail, succeed, succeed] maps
        // to [first-fail, second-fail, first-succeed, second-succeed].
        const perform = jest
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(error)
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce('first')
            .mockResolvedValueOnce('second');

        const operation = makeOperation(perform);

        const delay = jest.fn<(attempt: number, error: TrialError) => number>((attempt) => {
            delayAttempts.push(attempt);
            return 0;
        });

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const retry = new Retry(operation, 2, () => true, delay, sleep);

        const first = retry.perform();
        const second = retry.perform();

        const results = await Promise.all([first, second]);

        expect(results).toEqual(['first', 'second']);
        expect(perform).toHaveBeenCalledTimes(4);
        expect(delayAttempts).toHaveLength(2);
        expect(delayAttempts.every((attempt) => attempt === 0)).toBe(true);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('keeps configuration immutable during execution', async () => {
        let maxAttempts = 3;

        const error = retryableError();
        const perform = jest.fn<() => Promise<string>>().mockRejectedValue(error);
        const operation = makeOperation(perform);
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const retry = new Retry(operation, maxAttempts, () => true, 10, sleep);

        maxAttempts = 1;

        await expect(retry.perform()).rejects.toBe(error);

        expect(operation.perform).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not accumulate state across repeated retry cycles (stability smoke test)', async () => {
        const perform = jest.fn<() => Promise<string>>();

        const retry = new Retry(
            makeOperation(perform),
            2,
            () => true,
            0,
            jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined),
        );

        for (let i = 0; i < 1000; i++) {
            perform.mockRejectedValueOnce(new HttpException(`error ${i}`, 500)).mockResolvedValueOnce('ok');
            await expect(retry.perform()).resolves.toBe('ok');
        }

        expect(perform).toHaveBeenCalledTimes(2000);
    });

    it('does not hold references to large error payloads after a cycle completes (stability smoke test)', async () => {
        const perform = jest.fn<() => Promise<string>>();
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
        const retry = new Retry(makeOperation(perform), 2, () => true, 0, sleep);

        for (let i = 0; i < 100; i++) {
            perform
                .mockRejectedValueOnce(
                    new HttpException(`error ${i}`, 500, undefined, {
                        context: {
                            payload: 'x'.repeat(10_000),
                        },
                    }),
                )
                .mockResolvedValueOnce('ok');

            await expect(retry.perform()).resolves.toBe('ok');
        }

        expect(perform).toHaveBeenCalledTimes(200);
    });
});
