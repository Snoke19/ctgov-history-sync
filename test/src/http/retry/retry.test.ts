import { describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError, HttpException, TrialError, UnexpectedError } from '../../../../src/error/errors.js';
import { BusinessOperation } from '../../../../src/retry/businessOperation.js';
import { Retry } from '../../../../src/retry/retry.js';

describe('Retry', () => {
    const retryableError = () => new HttpException('server error', 500);

    function makeOp(perform: jest.Mock<() => Promise<string>>) {
        return { perform } as unknown as BusinessOperation<string>;
    }

    it('accepts maxRetries: 0', async () => {
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        await expect(new Retry(op, 0, () => true, 1, sleep).perform()).rejects.toBeInstanceOf(HttpException);

        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maxRetries: %s', (maxRetries) => {
        const op = makeOp(jest.fn<() => Promise<string>>());
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

        expect(() => new Retry(op, maxRetries, () => true, 1, sleep)).toThrow(
            'maxRetries must be a non-negative integer',
        );
    });

    it('returns the operation result on the first successful attempt', async () => {
        const op = makeOp(jest.fn<() => Promise<string>>().mockResolvedValue('ok'));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>();

        const result = await new Retry(op, 3, () => true, 1, sleep).perform();

        expect(result).toBe('ok');
        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries a failed attempt and returns the eventual success', async () => {
        const error = retryableError();
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValueOnce('ok'));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const result = await new Retry(op, 2, () => true, 10, sleep).perform();

        expect(result).toBe('ok');
        expect(op.perform).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(10, undefined);
    });

    it('retries up to maxRetries and surfaces the final error when exhausted', async () => {
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const promise = new Retry(op, 2, () => true, 1, sleep).perform();

        await expect(promise).rejects.toBeInstanceOf(HttpException);
        expect(op.perform).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('normalizes a non-TrialError immediately without retrying', async () => {
        const boom = new Error('boom');

        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(boom));

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const promise = new Retry(op, 3, () => true, 1, sleep).perform();

        await expect(promise).rejects.toBeInstanceOf(UnexpectedError);

        await expect(promise).rejects.toMatchObject({
            cause: boom,
        });

        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('does not retry when shouldRetry returns false', async () => {
        const error = retryableError();
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(error));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const promise = new Retry(op, 3, () => false, 1, sleep).perform();

        await expect(promise).rejects.toBe(error);
        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('passes the zero-indexed attempt and the failed error to a delay function', async () => {
        const error = retryableError();
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValueOnce('ok'));
        const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(25);
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const result = await new Retry(op, 2, () => true, delay, sleep).perform();

        expect(result).toBe('ok');
        expect(delay).toHaveBeenCalledWith(0, error);
        expect(sleep).toHaveBeenCalledWith(25, undefined);
    });

    it('waits at least 0 ms even when the computed delay is negative', async () => {
        const op = makeOp(
            jest.fn<() => Promise<string>>().mockRejectedValueOnce(retryableError()).mockResolvedValueOnce('ok'),
        );
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        await new Retry(op, 2, () => true, -100, sleep).perform();

        expect(sleep).toHaveBeenCalledWith(0, undefined);
    });

    it('throws CallerAbortedError when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const promise = new Retry(op, 2, () => true, 1, sleep, controller.signal).perform();

        await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('throws CallerAbortedError when the signal aborts during the backoff wait', async () => {
        const controller = new AbortController();
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockImplementation(async () => {
            controller.abort();
        });

        const promise = new Retry(op, 2, () => true, 1, sleep, controller.signal).perform();

        await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('normalizes a sleep rejection when the signal is not aborted', async () => {
        const sleepError = new Error('sleep boom');

        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockRejectedValue(sleepError);

        const promise = new Retry(op, 2, () => true, 1, sleep).perform();

        await expect(promise).rejects.toBeInstanceOf(UnexpectedError);

        await expect(promise).rejects.toMatchObject({
            cause: sleepError,
        });

        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('throws CallerAbortedError when the caller aborts after a failed attempt before retry', async () => {
        const controller = new AbortController();

        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));

        const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation(() => {
            controller.abort();
            return 1;
        });

        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const promise = new Retry(op, 2, () => true, delay, sleep, controller.signal).perform();

        await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);

        expect(op.perform).toHaveBeenCalledTimes(1);
        expect(delay).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });
});
