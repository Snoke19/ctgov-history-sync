import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { CallerAbortedError, NetworkException, TimeoutException } from '../../../../src/error/errors.js';
import { DefaultLimiterFactory } from '../../../../src/http/limiter/factory/defaultLimiterFactory.js';
import {
    createAbortableFetchMock,
    createAbortableRequestMock,
    createAbortError,
} from '../../fixtures/abort.fixture.js';
import { expectRejected } from '../../fixtures/assertion.fixture.js';
import { createClockFixture } from '../../fixtures/clock.fixture.js';
import { API_URL } from '../../fixtures/constants.js';
import { createTestClient } from '../../fixtures/httpClient.fixture.js';
import { withClosedClient } from '../../fixtures/lifecycle.fixture.js';
import { jsonResponse } from '../../fixtures/response.fixture.js';

function createAbortableSleepMock(): {
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

describe('HttpClient network & timeout failures', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('retries a transient TLS handshake failure and succeeds on the next attempt', async () => {
        const tlsError = Object.assign(new Error('TLS handshake failure'), {
            code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
        });

        const fetchError = new TypeError('fetch failed');
        fetchError.cause = tlsError;

        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(fetchError)
            .mockResolvedValueOnce(jsonResponse({ ok: true }));

        const client = await createTestClient();

        try {
            const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/tls-failure`, {
                maxRetries: 1,
            });

            expect(result).toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            await client.close();
        }
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

        const client = await createTestClient();

        try {
            const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/conn-reset`, { maxRetries: 2 });

            expect(result).toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            await client.close();
        }
    });

    it('throws NetworkException after exhausting all retry attempts', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(
            Object.assign(new TypeError('fetch failed: ECONNREFUSED'), {
                code: 'ECONNREFUSED',
            }),
        );

        const client = await createTestClient();

        try {
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
        } finally {
            await client.close();
        }
    });

    it('throws CallerAbortedError without making a request when caller AbortSignal is already aborted', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch');

        const client = await createTestClient();

        const controller = new AbortController();
        controller.abort();

        const error = await expectRejected(
            client.fetchJson(`${API_URL}/cancelled`, {
                signal: controller.signal,
            }),
            CallerAbortedError,
        );

        expect(error.message).toContain('Request cancelled by caller: http://api.test/cancelled');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws TimeoutException when HTTP request exceeds timeoutMs', async () => {
        const fetchMock = createAbortableFetchMock();
        const client = await createTestClient();

        await withClosedClient(client, async () => {
            const error = await expectRejected(
                client.fetchJson(`${API_URL}/slow`, {
                    timeoutMs: 50,
                    maxRetries: 0,
                }),
                TimeoutException,
            );

            expect(error.message).toContain(
                'Request timed out after 50ms: http://api.test/slow — cause: AbortError: The operation was aborted.',
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('does NOT retry a timeout when retryPolicy.retryOnTimeout is false', async () => {
        const fetchMock = createAbortableFetchMock();
        const client = await createTestClient();

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
                'Request timed out after 50ms: http://api.test/timeout-no-retry — cause: AbortError: The operation was aborted.',
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

        const client = await createTestClient({ sleep: sleepMock });

        await withClosedClient(client, async () => {
            const pending = client.fetchJson(`${API_URL}/abort-during-backoff`, {
                signal: controller.signal,
                maxRetries: 3,
            });

            await started;
            controller.abort();

            await expect(pending).rejects.toBeInstanceOf(CallerAbortedError);

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledWith(expect.any(Number), controller.signal);
        });
    });

    it('throws CallerAbortedError when caller aborts during HTTP request', async () => {
        const controller = new AbortController();

        let requestStarted = false;

        const requestStartedPromise = new Promise<void>((resolve) => {
            createAbortableRequestMock(() => {
                requestStarted = true;
                resolve();
            });
        });

        const client = await createTestClient();

        await withClosedClient(client, async () => {
            const pending = client.fetchJson(`${API_URL}/slow`, {
                signal: controller.signal,
                maxRetries: 1,
            });

            await requestStartedPromise;
            expect(requestStarted).toBe(true);

            controller.abort();

            const error = await expectRejected(pending, CallerAbortedError);
            expect(error.name).toBe('CallerAbortedError');
        });
    });

    it('does not leak abort listeners across requests', async () => {
        jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

        const controller = new AbortController();
        const client = await createTestClient();

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

        const fakes = createClockFixture();

        const client = await createTestClient(
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
