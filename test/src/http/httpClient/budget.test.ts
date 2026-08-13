import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigurationError, NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { EndpointManager } from '../../../../src/http/endpoint/manager/endpointManager.js';
import { API_URL, createFakes, jsonResponse, makeClient } from './helpers.js';

describe('HttpClient deadline budget', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each([NaN, Infinity, -Infinity])('rejects invalid deadline: %s', async (deadline) => {
        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/invalid`, { deadline })).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('accepts an already-expired finite deadline', async () => {
        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/expired`, { deadline: 0 })).rejects.toBeInstanceOf(TimeoutException);
    });

    it('rejects invalid retryPolicy baseDelayMs', async () => {
        const client = makeClient();

        await expect(
            client.fetchJson(`${API_URL}/invalid`, {
                retryPolicy: { baseDelayMs: -1 },
            }),
        ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('rejects invalid retryPolicy status codes', async () => {
        const client = makeClient();

        await expect(
            client.fetchJson(`${API_URL}/invalid`, {
                retryPolicy: {
                    retryableStatusCodes: new Set([99]),
                },
            }),
        ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it.each([-1, 1.5, NaN, Infinity])('rejects invalid timeoutMs: %s', async (timeoutMs) => {
        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/invalid`, { timeoutMs })).rejects.toBeInstanceOf(ConfigurationError);
    });

    it.each([-1, 1.5, NaN, Infinity])('rejects invalid maxRetries: %s', async (maxRetries) => {
        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/invalid`, { maxRetries })).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('allows maxRetries: 0', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/no-retries`, { maxRetries: 0 })).rejects.toBeInstanceOf(
            NetworkException,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('enforces the earlier deadline when it is shorter than timeoutMs', async () => {
        jest.useFakeTimers();

        try {
            const fakes = createFakes();

            const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
                return new Promise((_, reject) => {
                    const signal = init?.signal as AbortSignal | undefined;

                    if (!signal) {
                        throw new Error('Expected request signal');
                    }

                    const onAbort = () => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    };

                    if (signal.aborted) {
                        onAbort();
                        return;
                    }

                    signal.addEventListener('abort', onAbort, { once: true });
                });
            });

            const client = makeClient({
                clock: fakes.clock,
                sleep: fakes.sleep,
                random: fakes.random,
            });

            const promise = client.fetchJson(`${API_URL}/deadline-vs-timeout`, {
                timeoutMs: 60_000,
                deadline: 10_000,
                maxRetries: 0,
            });

            await Promise.resolve();

            fakes.clock.advance(10_000);
            jest.advanceTimersByTime(10_000);

            await expect(promise).rejects.toBeInstanceOf(TimeoutException);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fakes.clock.now()).toBe(10_000);
        } finally {
            jest.useRealTimers();
        }
    });

    it('enforces timeoutMs even when deadline is much later', async () => {
        jest.useFakeTimers();

        try {
            const fakes = createFakes();

            const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
                return new Promise((_, reject) => {
                    const signal = init?.signal as AbortSignal | undefined;

                    if (!signal) {
                        throw new Error('Expected request signal');
                    }

                    const onAbort = () => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    };

                    if (signal.aborted) {
                        onAbort();
                        return;
                    }

                    signal.addEventListener('abort', onAbort, { once: true });
                });
            });

            const client = makeClient({
                clock: fakes.clock,
                sleep: fakes.sleep,
                random: fakes.random,
            });

            const promise = client.fetchJson(`${API_URL}/timeout-vs-deadline`, {
                timeoutMs: 10_000,
                deadline: 60_000,
                maxRetries: 0,
            });

            // Let the request reach the mocked fetch.
            await Promise.resolve();

            // Advance both time sources:
            // - Jest timer → fires FetchOperation's timeout
            // - FakeClock → makes the elapsed request time 10s
            fakes.clock.advance(10_000);
            jest.advanceTimersByTime(10_000);

            await expect(promise).rejects.toBeInstanceOf(TimeoutException);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fakes.clock.now()).toBe(10_000);
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not sleep past the global deadline when Retry-After exceeds the remaining budget', async () => {
        const fakes = createFakes();

        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                jsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '30' }, 'Too Many Requests'),
            );

        const client = makeClient({
            clock: fakes.clock,
            sleep: fakes.sleep,
            random: fakes.random,
        });

        const promise = client.fetchJson(`${API_URL}/deadline-backoff`, {
            deadline: 1000,
            maxRetries: 1,
        });

        // First request fails immediately; the retry-after is 30s,
        // but only 1s remains in the global request budget.
        await expect(promise).rejects.toBeInstanceOf(TimeoutException);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fakes.clock.now()).toBe(1000);
    });

    it('forwards shrinking deadline budget to endpoint acquisition on each retry', async () => {
        // Deliberate regression pin: the remaining budget handed to
        // acquireEndpoint is not observable through the public API, so this
        // one internals spy is justified (see the black-box sibling test below
        // for the externally-visible deadline contract).
        const acquireSpy = jest.spyOn(EndpointManager.prototype, 'acquireEndpoint');

        jest.spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockRejectedValueOnce(new TypeError('fetch failed'));

        const client = makeClient();
        // Deadline is relative to the injected clock (createDefaultOptions
        // seeds FakeClock at 0). Each retry's backoff sleep advances that same
        // clock (FakeSleeper), so the remaining budget must shrink without any
        // real Date.now involvement.
        const deadline = 5000;

        await expect(client.fetchJson(`${API_URL}/budget`, { deadline, maxRetries: 2 })).rejects.toBeInstanceOf(
            NetworkException,
        );

        expect(acquireSpy).toHaveBeenCalledTimes(3); // initial + 2 retries

        const firstRemaining = acquireSpy.mock.calls[0]![0] as number;
        const secondRemaining = acquireSpy.mock.calls[1]![0] as number;
        const thirdRemaining = acquireSpy.mock.calls[2]![0] as number;

        // Each retry must see a smaller (or equal) remaining budget, never a fresh window
        expect(secondRemaining).toBeLessThanOrEqual(firstRemaining);
        expect(thirdRemaining).toBeLessThanOrEqual(secondRemaining);

        acquireSpy.mockRestore();
    });

    it('throws TimeoutException when the deadline budget is exhausted between retries', async () => {
        // Time starts with 5s of budget remaining; the expiry on the failed
        // request pushes the injected clock past the deadline that the retry
        // would need. The clock is injected through HttpClientOptions, the
        // same source FetchOperation uses for the deadline arithmetic.
        const fakes = createFakes();
        fakes.clock.advance(1_000_000);

        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            fakes.clock.advance(6_001);
            return Promise.reject(new TypeError('fetch failed: ECONNRESET'));
        });

        const client = makeClient({ clock: fakes.clock, sleep: fakes.sleep, random: fakes.random });

        await expect(
            client.fetchJson(`${API_URL}/deadline-exhausted`, {
                deadline: 1_005_000,
                maxRetries: 1,
            }),
        ).rejects.toBeInstanceOf(TimeoutException);

        // The global budget ran out before the retry could start another request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
