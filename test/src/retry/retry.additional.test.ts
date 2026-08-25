import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
    CallerAbortedError,
    ConfigurationError,
    HttpException,
    RetryDelayCalculationError,
    TrialError,
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
const { calculateBackoff } = await import('../../../src/retry/retryPolicy.js');

describe('Retry additional edge cases', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function makeOperation(perform: jest.Mock<() => Promise<string>>): BusinessOperation<string> {
        return { perform };
    }

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
            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(0);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(makeOperation(perform), 3, () => true, delay, sleep);

            await expect(retry.perform()).resolves.toBe('ok');
            expect(delay).toHaveBeenNthCalledWith(1, 0, firstError);
            expect(delay).toHaveBeenNthCalledWith(2, 1, secondError);
            expect(delay).toHaveBeenCalledTimes(2);
        });

        it('wraps a delay callback exception in RetryDelayCalculationError', async () => {
            const callbackError = new Error('delay calculation failed');
            const operation = makeOperation(
                jest.fn<() => Promise<string>>().mockRejectedValue(new HttpException('server error', 500)),
            );
            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation(() => {
                throw callbackError;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, delay, sleep);
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
            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockReturnValue(value);
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(operation, 2, () => true, delay, sleep);
            const result = retry.perform();

            await expect(result).rejects.toBeInstanceOf(RetryDelayCalculationError);
            expect(operation.perform).toHaveBeenCalledTimes(1);
            expect(sleep).not.toHaveBeenCalled();
        });
    });

    describe('concurrent execution state isolation', () => {
        it('keeps attempt numbering independent for concurrent perform calls on the same Retry instance', async () => {
            const firstError = new HttpException('first call failure', 503);
            const secondError = new HttpException('second call failure', 503);
            let callCount = 0;

            const perform = jest.fn<() => Promise<string>>().mockImplementation(async () => {
                callCount++;
                if (callCount === 1) throw firstError;
                if (callCount === 2) throw secondError;
                return callCount === 3 ? 'first recovered' : 'second recovered';
            });

            const delayAttempts: number[] = [];
            const delayErrors: TrialError[] = [];
            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation((attempt, error) => {
                delayAttempts.push(attempt);
                delayErrors.push(error);
                return 0;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(makeOperation(perform), 2, () => true, delay, sleep);
            const [firstResult, secondResult] = await Promise.all([retry.perform(), retry.perform()]);

            expect(firstResult).toBe('first recovered');
            expect(secondResult).toBe('second recovered');
            expect(perform).toHaveBeenCalledTimes(4);
            expect(delayAttempts).toEqual([0, 0]);
            expect(delayErrors).toEqual([firstError, secondError]);
            expect(sleep).toHaveBeenCalledTimes(2);
        });

        it('does not leak one perform call state into a later perform call', async () => {
            const perform = jest
                .fn<() => Promise<string>>()
                .mockRejectedValueOnce(new HttpException('first failure', 500))
                .mockResolvedValueOnce('first ok')
                .mockRejectedValueOnce(new HttpException('second failure', 500))
                .mockResolvedValueOnce('second ok');
            const delayAttempts: number[] = [];
            const delay = jest.fn<(attempt: number, error: TrialError) => number>().mockImplementation((attempt) => {
                delayAttempts.push(attempt);
                return 0;
            });
            const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

            const retry = new Retry(makeOperation(perform), 2, () => true, delay, sleep);

            await expect(retry.perform()).resolves.toBe('first ok');
            await expect(retry.perform()).resolves.toBe('second ok');
            expect(delayAttempts).toEqual([0, 0]);
        });
    });

    describe('backoff overflow protection', () => {
        it('returns the configured cap when exponential calculation overflows', () => {
            const cap = 30_000;
            const result = calculateBackoff(1024, null, {
                random: () => 0,
                baseDelayMs: 1_000,
                backoffCapMs: cap,
            });

            expect(result).toBe(cap);
        });
    });

    describe('jitter random contract', () => {
        it('returns the base delay when random returns 0', () => {
            const result = calculateBackoff(0, null, {
                random: () => 0,
                baseDelayMs: 1_000,
                backoffCapMs: 10_000,
            });

            expect(result).toBe(1_000);
        });

        it('returns base delay plus the maximum 50% jitter when random returns 1', () => {
            const result = calculateBackoff(0, null, {
                random: () => 1,
                baseDelayMs: 1_000,
                backoffCapMs: 10_000,
            });

            expect(result).toBe(1_500);
        });

        it.each([
            ['negative', -0.01],
            ['above one', 1.01],
            ['NaN', Number.NaN],
            ['positive Infinity', Number.POSITIVE_INFINITY],
            ['negative Infinity', Number.NEGATIVE_INFINITY],
        ])('rejects invalid random() output: %s', (_, value) => {
            expect(() =>
                calculateBackoff(0, null, {
                    random: () => value,
                    baseDelayMs: 1_000,
                    backoffCapMs: 10_000,
                }),
            ).toThrow(ConfigurationError);
        });
    });
});
