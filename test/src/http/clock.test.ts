import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError } from '../../../src/error/errors.js';
import { defaultSleeper } from '../../../src/http/clock.js';

describe('defaultSleeper', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('resolves after the timer completes and leaves no pending timer', async () => {
        jest.useFakeTimers();

        const promise = defaultSleeper.sleep(1000);

        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(1000);

        await expect(promise).resolves.toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('rejects with CallerAbortedError and clears the timer when cancelled', async () => {
        jest.useFakeTimers();

        const controller = new AbortController();
        const promise = defaultSleeper.sleep(10_000, controller.signal);

        expect(jest.getTimerCount()).toBe(1);

        controller.abort();

        await expect(promise).rejects.toBeInstanceOf(CallerAbortedError);
        expect(jest.getTimerCount()).toBe(0);

        jest.advanceTimersByTime(10_000);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('does not block the event loop while waiting', async () => {
        jest.useFakeTimers();

        let callbackExecuted = false;

        const promise = defaultSleeper.sleep(1000);

        const immediate = new Promise<void>((resolve) => {
            setImmediate(() => {
                callbackExecuted = true;
                resolve();
            });
        });

        jest.advanceTimersByTime(1000);
        await promise;
        await immediate;

        expect(callbackExecuted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    });
});
