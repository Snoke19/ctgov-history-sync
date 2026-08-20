import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError, NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { HttpClient } from '../../../../src/http/httpClient.js';
import { DefaultLimiterFactory } from '../../../../src/http/limiter/factory/defaultLimiterFactory.js';
import { API_URL, createFakes, jsonResponse, makeClient } from './helpers.js';

async function expectRejected<T extends Error>(
    promise: Promise<unknown>,
    errorClass: new (...args: never[]) => T,
): Promise<T> {
    const error = await promise.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(errorClass);
    return error as T;
}

function createAbortError(): DOMException {
    return new DOMException('The operation was aborted.', 'AbortError');
}

export function createAbortableFetchMock(): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
            const signal = init?.signal as AbortSignal | undefined;

            if (!signal) {
                return;
            }

            const onAbort = (): void => {
                reject(createAbortError());
            };

            if (signal.aborted) {
                onAbort();
                return;
            }

            signal.addEventListener('abort', onAbort, { once: true });
        });
    });
}

export async function withClosedClient(client: HttpClient, callback: () => Promise<void>): Promise<void> {
    try {
        await callback();
    } finally {
        await client.close();
    }
}

export function createAbortableSleepMock(): {
    sleep: jest.MockedFunction<(ms: number, signal?: AbortSignal) => Promise<void>>;
    started: Promise<void>;
} {
    let resolveStarted!: () => void;

    const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
    });

    const sleep = jest.fn(
        (_ms: number, signal?: AbortSignal) =>
            new Promise<void>((_, reject) => {
                if (!signal || signal.aborted) {
                    reject(createAbortError());
                    return;
                }

                resolveStarted();

                signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
            }),
    );

    return { sleep, started };
}

export function createAbortableRequestMock(onRequestStarted: () => void): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
        return new Promise((_, reject) => {
            const signal = init?.signal as AbortSignal | undefined;

            if (!signal) {
                throw new Error('Expected fetch signal');
            }

            const onAbort = (): void => {
                reject(createAbortError());
            };

            if (signal.aborted) {
                onAbort();
                return;
            }

            signal.addEventListener('abort', onAbort, { once: true });
            onRequestStarted();
        });
    });
}

describe('HttpClient network & timeout failures', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('retries a network failure and succeeds on the next attempt', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(
                Object.assign(new TypeError('fetch failed: ECONNRESET'), {
                    code: 'ECONNRESET',
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ ok: true }));

        const client = await makeClient();

        const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/conn-reset`, { maxRetries: 2 });

        expect(result).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws NetworkException after exhausting all retry attempts', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
            Object.assign(new TypeError('fetch failed: ECONNREFUSED'), {
                code: 'ECONNREFUSED',
            }),
        );

        const client = await makeClient();

        const error = await expectRejected(
            client.fetchJson(`${API_URL}/unreachable`, {
                maxRetries: 1,
            }),
            NetworkException,
        );

        expect(error.message).toContain(
            'Network failure: http://api.test/unreachable — cause: TypeError (ECONNREFUSED): fetch failed: ECONNREFUSED',
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
        const fetchMock = createAbortableFetchMock();
        const client = await makeClient();

        await withClosedClient(client, async () => {
            const error = await expectRejected(
                client.fetchJson(`${API_URL}/slow`, {
                    timeoutMs: 50,
                    maxRetries: 0,
                }),
                TimeoutException,
            );

            expect(error.message).toContain('Request timed out after 50ms: http://api.test/slow — cause: {}');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('does NOT retry a timeout when retryPolicy.retryOnTimeout is false', async () => {
        const fetchMock = createAbortableFetchMock();
        const client = await makeClient();

        await withClosedClient(client, async () => {
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
        });
    });

    it('aborts the retry backoff wait immediately when the caller cancels mid-delay', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
            Object.assign(new TypeError('fetch failed: ECONNRESET'), {
                code: 'ECONNRESET',
            }),
        );

        const controller = new AbortController();

        const { sleep: sleepMock, started } = createAbortableSleepMock();

        const client = await makeClient({ sleep: sleepMock });

        await withClosedClient(client, async () => {
            const pending = client.fetchJson(`${API_URL}/abort-during-backoff`, {
                signal: controller.signal,
                maxRetries: 3,
            });

            await started;
            controller.abort();

            await expect(pending).rejects.toBeInstanceOf(NetworkException);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledWith(expect.any(Number), controller.signal);
        });
    });

    it('throws NetworkException when caller aborts during HTTP request', async () => {
        const controller = new AbortController();

        let requestStarted = false;

        const requestStartedPromise = new Promise<void>((resolve) => {
            createAbortableRequestMock(() => {
                requestStarted = true;
                resolve();
            });
        });

        const client = await makeClient();

        await withClosedClient(client, async () => {
            const pending = client.fetchJson(`${API_URL}/slow`, {
                signal: controller.signal,
                maxRetries: 1,
            });

            await requestStartedPromise;
            expect(requestStarted).toBe(true);

            controller.abort();

            const error = await expectRejected(pending, NetworkException);
            expect(error.cause).toBeInstanceOf(CallerAbortedError);
        });
    });

    it('does not leak abort listeners across requests', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const controller = new AbortController();
        const client = await makeClient();

        await withClosedClient(client, async () => {
            for (let i = 0; i < 3; i++) {
                const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/leak-${i}`, {
                    signal: controller.signal,
                });

                expect(result).toEqual({ ok: true });
                expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            }
        });
    });

    it('enforces the rate limit between requests', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const fakes = createFakes();

        const client = await makeClient(
            {
                sleep: fakes.sleep,
                random: fakes.random,
                monotonicClock: fakes.monotonicClock,
                wallClock: fakes.wallClock,
            },
            new DefaultLimiterFactory({
                enabled: true,
                capacity: 1,
                windowMs: 100,
                clock: fakes.monotonicClock.now,
                sleep: fakes.sleep,
            }),
        );

        await withClosedClient(client, async () => {
            const timeBefore = fakes.monotonicClock.now();

            await client.fetchJson(`${API_URL}/a`);
            await client.fetchJson(`${API_URL}/b`);

            const timeAfter = fakes.monotonicClock.now();

            expect(timeAfter - timeBefore).toBe(100);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });
});
