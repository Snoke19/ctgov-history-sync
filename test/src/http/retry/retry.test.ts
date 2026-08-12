import { describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError, HttpException, TrialError } from '../../../../src/error/errors.js';
import { BusinessOperation } from '../../../../src/http/retry/businessOperation.js';
import { Retry } from '../../../../src/http/retry/retry.js';

describe('Retry', () => {
    const retryableError = () => new HttpException('server error', 500);

    function makeOp(perform: jest.Mock<() => Promise<string>>) {
        return { perform } as unknown as BusinessOperation<string>;
    }

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

    it('rethrows a non-TrialError immediately without retrying', async () => {
        const boom = new Error('boom');
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(boom));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        const promise = new Retry(op, 3, () => true, 1, sleep).perform();

        await expect(promise).rejects.toBe(boom);
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

    it('rethrows a sleep rejection when the signal is not aborted', async () => {
        const op = makeOp(jest.fn<() => Promise<string>>().mockRejectedValue(retryableError()));
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockRejectedValue(new Error('sleep boom'));

        const promise = new Retry(op, 2, () => true, 1, sleep).perform();

        await expect(promise).rejects.toThrow('sleep boom');
    });
});
