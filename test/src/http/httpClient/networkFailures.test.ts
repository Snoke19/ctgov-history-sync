import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { API_URL, createFakes, jsonResponse, makeClient } from './helpers.js';

async function expectRejected<T extends Error>(
    promise: Promise<unknown>,
    errorClass: new (...args: never[]) => T,
): Promise<T> {
    const error = await promise.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(errorClass);
    return error as T;
}

describe('HttpClient network & timeout failures', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it.each(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])(
        'maps Undici %s to TimeoutException',
        async (code) => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockRejectedValueOnce(Object.assign(new Error(`${code} Error`), { code }));

            const client = await makeClient();

            const error = await expectRejected(
                client.fetchJson(`${API_URL}/timeout`, {
                    maxRetries: 0,
                }),
                TimeoutException,
            );

            expect(error.message).toContain('Request timed out after');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    it('retries a network failure and succeeds on the next attempt', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
            .mockResolvedValueOnce(jsonResponse({ ok: true }));

        const client = await makeClient();

        const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/conn-reset`, { maxRetries: 2 });

        expect(result).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws NetworkException after exhausting all retry attempts', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));

        const client = await makeClient();

        const error = await expectRejected(
            client.fetchJson(`${API_URL}/unreachable`, {
                maxRetries: 1,
            }),
            NetworkException,
        );

        expect(error.message).toContain(
            'Network failure: http://api.test/unreachable — cause: TypeError: fetch failed: ECONNREFUSED',
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws NetworkException without making a request when caller AbortSignal is already aborted', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch');

        const client = await makeClient();

        const controller = new AbortController();
        controller.abort();

        const error = await expectRejected(
            client.fetchJson(`${API_URL}/cancelled`, {
                signal: controller.signal,
            }),
            NetworkException,
        );

        expect(error.message).toContain('Request cancelled by caller: http://api.test/cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws TimeoutException when HTTP request exceeds timeoutMs', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            return new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;

                if (!signal) {
                    return;
                }

                const onAbort = (): void => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                };

                if (signal.aborted) {
                    onAbort();
                    return;
                }

                signal.addEventListener('abort', onAbort, { once: true });
            });
        });

        const client = await makeClient();

        try {
            const error = await expectRejected(
                client.fetchJson(`${API_URL}/slow`, {
                    timeoutMs: 50,
                    maxRetries: 0,
                }),
                TimeoutException,
            );

            expect(error.message).toContain('Request timed out after 50ms: http://api.test/slow — cause: {}');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            await client.close();
        }
    });

    it('does NOT retry a timeout when retryPolicy.retryOnTimeout is false', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
            return new Promise((_, reject) => {
                const signal = init?.signal as AbortSignal | undefined;

                if (signal) {
                    const onAbort = (): void => {
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

        const client = await makeClient();

        try {
            const error = await expectRejected(
                client.fetchJson(`${API_URL}/timeout-no-retry`, {
                    timeoutMs: 50,
                    maxRetries: 2,
                    retryPolicy: { retryOnTimeout: false },
                }),
                TimeoutException,
            );

            expect(error.message).toContain(
                'Request timed out after 50ms: http://api.test/timeout-no-retry — cause: {}',
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            await client.close();
        }
    });

    it('aborts the retry backoff wait immediately when the caller cancels mid-delay', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed: ECONNRESET'));

        const controller = new AbortController();

        let backoffSignal: AbortSignal | undefined;

        const sleepMock = jest.fn(
            (_ms: number, signal?: AbortSignal) =>
                new Promise<void>((_, reject) => {
                    if (!signal || signal.aborted) {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                        return;
                    }

                    backoffSignal = signal;

                    signal.addEventListener(
                        'abort',
                        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
                        { once: true },
                    );
                }),
        );

        const client = await makeClient({ sleep: sleepMock });

        try {
            const pending = client.fetchJson(`${API_URL}/abort-during-backoff`, {
                signal: controller.signal,
                maxRetries: 3,
            });

            await new Promise<void>((resolve) => {
                const check = (): void => {
                    if (backoffSignal) {
                        resolve();
                        return;
                    }

                    queueMicrotask(check);
                };

                check();
            });

            controller.abort();

            await expect(pending).rejects.toBeInstanceOf(NetworkException);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledWith(expect.any(Number), controller.signal);
        } finally {
            await client.close();
        }
    });

    it('throws NetworkException when caller aborts during HTTP request', async () => {
        const controller = new AbortController();

        const requestStarted = new Promise<void>((resolve) => {
            jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
                return new Promise((_, reject) => {
                    const signal = init?.signal as AbortSignal | undefined;

                    if (!signal) {
                        throw new Error('Expected fetch signal');
                    }

                    const onAbort = (): void => {
                        reject(new DOMException('The operation was aborted.', 'AbortError'));
                    };

                    if (signal.aborted) {
                        onAbort();
                        return;
                    }

                    signal.addEventListener('abort', onAbort, { once: true });
                    resolve();
                });
            });
        });

        const client = await makeClient();

        try {
            const pending = client.fetchJson(`${API_URL}/slow`, {
                signal: controller.signal,
                maxRetries: 1,
            });

            await requestStarted;
            controller.abort();

            await expect(pending).rejects.toBeInstanceOf(NetworkException);
        } finally {
            await client.close();
        }
    });

    it('does not leak abort listeners across requests', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const controller = new AbortController();
        const client = await makeClient();

        for (let i = 0; i < 3; i++) {
            const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/leak-${i}`, {
                signal: controller.signal,
            });
            expect(result).toEqual({ ok: true });
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        }
    });

    it('enforces the rate limit between requests', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const fakes = createFakes();

        const client = await makeClient({
            useRateLimit: true,
            rateLimitCapacity: 1,
            rateLimitWindow: 100,
            sleep: fakes.sleep,
            random: fakes.random,
            monotonicClock: fakes.monotonicClock,
            wallClock: fakes.wallClock,
        });

        const timeBefore = fakes.monotonicClock.now();

        await client.fetchJson(`${API_URL}/a`);
        await client.fetchJson(`${API_URL}/b`);

        const timeAfter = fakes.monotonicClock.now();

        expect(timeAfter - timeBefore).toBe(100);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
