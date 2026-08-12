import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { API_URL, createFakes, jsonResponse, makeClient } from './helpers.js';

describe('HttpClient network & timeout failures', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('retries network failures up to the configured maxRetries', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));

        const client = makeClient();

        const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/conn-reset`, { maxRetries: 2 });

        expect(result).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws NetworkException after exhausting the configured maximum number of total attempts', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));

        const client = makeClient();

        await expect(
            client.fetchJson(`${API_URL}/unreachable`, {
                maxRetries: 1,
            }),
        ).rejects.toBeInstanceOf(NetworkException);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects immediately with NetworkException when caller AbortSignal is pre-aborted', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch');

        const client = makeClient();

        const controller = new AbortController();
        controller.abort();

        await expect(
            client.fetchJson(`${API_URL}/cancelled`, {
                signal: controller.signal,
            }),
        ).rejects.toBeInstanceOf(NetworkException);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws TimeoutException when request exceeds timeoutMs', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            return new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;

                if (signal) {
                    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));

                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                // No safety timer needed here — the internal AbortController
                // guarantees the signal will abort after timeoutMs.
            });
        });

        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/slow`, { timeoutMs: 50, maxRetries: 1 })).rejects.toBeInstanceOf(
            TimeoutException,
        );
    });

    it('does NOT retry a timeout when retryPolicy.retryOnTimeout is false', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            return new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;

                if (signal) {
                    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));

                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });
        });

        const client = makeClient();

        await expect(
            client.fetchJson(`${API_URL}/timeout-no-retry`, {
                timeoutMs: 50,
                maxRetries: 2,
                retryPolicy: { retryOnTimeout: false },
            }),
        ).rejects.toBeInstanceOf(TimeoutException);

        // The per-request policy opt-out must stop the retry that the global
        // default (retryOnTimeout: true) would otherwise have performed.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the retry backoff wait immediately when the caller cancels mid-delay', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: ECONNRESET'));

        const controller = new AbortController();

        // A sleep that only ever settles by being aborted — like a real backoff
        // under the default sleeper, but deterministic. It also asserts the
        // caller's signal is actually forwarded into the wait.
        const sleepMock = jest.fn(
            (_ms: number, signal?: AbortSignal) =>
                new Promise<void>((_, reject) => {
                    if (!signal || signal.aborted) {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                        return;
                    }
                    signal.addEventListener(
                        'abort',
                        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
                        { once: true },
                    );
                }),
        );

        const client = makeClient({ sleep: sleepMock });

        const pending = client.fetchJson(`${API_URL}/abort-during-backoff`, {
            signal: controller.signal,
            maxRetries: 3,
        });

        setTimeout(() => controller.abort(), 10);

        await expect(pending).rejects.toBeInstanceOf(NetworkException);
        // Cancelled at the first backoff wait: no second request is ever issued.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).toHaveBeenCalledWith(expect.any(Number), controller.signal);
        expect(sleepMock).toHaveBeenCalledTimes(1);
    });

    it('throws NetworkException when caller aborts during request', async () => {
        const controller = new AbortController();

        jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            return new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;

                const safetyTimer = setTimeout(() => reject(new Error('should not reach')), 1000);

                if (signal) {
                    const onAbort = () => {
                        clearTimeout(safetyTimer);
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    };
                    if (signal.aborted) {
                        onAbort();
                        return;
                    }
                    signal.addEventListener('abort', onAbort, { once: true });
                }
            });
        });

        const client = makeClient();
        setTimeout(() => controller.abort(), 10);

        await expect(
            client.fetchJson(`${API_URL}/slow`, {
                signal: controller.signal,
                maxRetries: 1,
            }),
        ).rejects.toBeInstanceOf(NetworkException);
    });

    it('detaches its abort listener from a shared caller signal after a successful request', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const controller = new AbortController();
        const client = makeClient();

        for (let i = 0; i < 3; i++) {
            // A long-lived caller signal shared across many requests must not
            // accumulate abort listeners with every successful request.
            const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/leak-${i}`, {
                signal: controller.signal,
            });
            expect(result).toEqual({ ok: true });
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        }
    });

    it('throttles requests when useRateLimit is enabled', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const fakes = createFakes();
        const client = makeClient({
            useRateLimit: true,
            rateLimitCapacity: 1,
            rateLimitWindow: 100, // 1 token per 100 ms
            sleep: fakes.sleep,
            random: fakes.random,
            clock: fakes.clock,
        });

        // Observable behaviour only: the second call must wait for the token to
        // refill (100ms). Asserting on EndpointManager.acquireEndpoint explicitly
        // would over-specify the implementation and churn under refactor.
        const timeBefore = fakes.clock.now();
        await client.fetchJson(`${API_URL}/a`);
        await client.fetchJson(`${API_URL}/b`);
        const timeAfter = fakes.clock.now();

        expect(timeAfter - timeBefore).toBe(100);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
