import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { EndpointManager } from '../../../../src/http/endpoint/manager/endpointManager.js';
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

    it('throws NetworkException when caller aborts during request', async () => {
        const controller = new AbortController();

        jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            return new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;
                let safetyTimer: NodeJS.Timeout | undefined;

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
                safetyTimer = setTimeout(() => reject(new Error('should not reach')), 1000);
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

        const acquireSpy = jest.spyOn(EndpointManager.prototype, 'acquireEndpoint');

        const timeBefore = fakes.clock.now();
        await client.fetchJson(`${API_URL}/a`);
        await client.fetchJson(`${API_URL}/b`);
        const timeAfter = fakes.clock.now();

        // EndpointManager had to loop: first call succeeded immediately,
        // second call waited for the token to refill (100ms).
        expect(acquireSpy).toHaveBeenCalledTimes(2);
        expect(timeAfter - timeBefore).toBe(100);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        acquireSpy.mockRestore();
    });
});