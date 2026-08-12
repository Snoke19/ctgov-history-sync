import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { TrialFetchError } from '../../../src/error/errors.js';
import { createHttpClient, HttpClient } from '../../../src/http/httpClient.js';
import { DirectEndpointProvider } from '../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { FetchDirectTransportFactory } from '../../../src/http/endpoint/transport/factory/fetchDirectTransportFactory.js';
import { FetchDirectTransport } from '../../../src/http/endpoint/transport/impl/fetchDirectTransport.js';
import { NetworkException, TimeoutException } from '../../../src/http/retry/exceptions.js';
import { HttpClientOptions } from '../../../src/http/types/http.js';

const API_URL = 'http://api.test';

const ENDPOINT_1 = 'http://test-proxy-1:8080';
const ENDPOINT_2 = 'http://test-proxy-2:8080';

class FakeClock {
    private _now = 0;
    now = () => this._now;
    advance = (ms: number) => {
        this._now += ms;
    };
}

class FakeSleeper {
    constructor(private clock: FakeClock) {}
    sleep = async (ms: number) => {
        this.clock.advance(ms);
        await Promise.resolve();
    };
}

function createFakes() {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    return {
        clock,
        sleep: sleeper.sleep.bind(sleeper),
        random: () => 0.5, // детермінований jitter: завжди 50% від base
    };
}

function jsonResponse<T>(body: T, status = 200, headers: Record<string, string> = {}, statusText = 'OK'): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        statusText,
        headers: {
            'content-type': 'application/json',
            ...headers,
        },
    });
}

function createDefaultOptions(overrides: Partial<HttpClientOptions> = {}): HttpClientOptions {
    const fakes = createFakes();
    return {
        concurrency: 5,
        acquireTimeout: 5000,
        rateLimitCapacity: 10,
        rateLimitWindow: 1000,
        useRateLimit: false,
        proxyUrls: 'http://test-proxy-0:8080',
        sleep: fakes.sleep,
        random: fakes.random,
        clock: fakes.clock,
        ...overrides,
    };
}

function makeClient(optionsOverrides: Partial<HttpClientOptions> = {}): { client: HttpClient } {
    const transportFactory = new FetchDirectTransportFactory();
    const provider = new DirectEndpointProvider(transportFactory);

    return {
        client: createHttpClient(createDefaultOptions(optionsOverrides), provider),
    };
}

describe('HttpClient Integration', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
    });

    describe('Happy Path & Response Parsing', () => {
        it('fetches and parses JSON payload successfully for 200 OK', async () => {
            const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
                jsonResponse({
                    id: 101,
                    title: 'Clinical Trial #1',
                }),
            );

            const { client } = makeClient();

            const result = await client.fetchJson<{ id: number; title: string }>(`${API_URL}/trials/101`);

            expect(result).toEqual({
                id: 101,
                title: 'Clinical Trial #1',
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledWith(
                `${API_URL}/trials/101`,
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({
                        Accept: 'application/json',
                    }),
                }),
            );
        });

        it('returns null for 204 No Content response without attempting JSON parse', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse(null, 204, {}, 'No Content'));

            const { client } = makeClient();

            const result = await client.fetchJson(`${API_URL}/trials/empty`);

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('forwards custom HTTP method, headers, and request body to transport', async () => {
            const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true }));

            const { client } = makeClient();

            const payload = JSON.stringify({ query: 'cancer' });

            const result = await client.fetchJson(`${API_URL}/search`, {
                method: 'POST',
                headers: {
                    'X-Custom-Header': 'TestValue',
                    'Content-Type': 'application/json',
                },
                body: payload,
            });

            expect(result).toEqual({ success: true });

            expect(fetchMock).toHaveBeenCalledWith(
                `${API_URL}/search`,
                expect.objectContaining({
                    method: 'POST',
                    body: payload,
                    headers: expect.objectContaining({
                        'X-Custom-Header': 'TestValue',
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    }),
                }),
            );
        });

        it('throws TrialFetchError when 200 OK response contains invalid JSON body', async () => {
            jest.spyOn(globalThis, 'fetch').mockResolvedValue(
                new Response('500 Internal Server Error', {
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        'content-type': 'application/json',
                    },
                }),
            );

            const { client } = makeClient();

            await expect(client.fetchJson(`${API_URL}/bad-json`)).rejects.toBeInstanceOf(TrialFetchError);
        });
    });

    describe('Retry Policy', () => {
        it('retries on 504 Gateway Timeout and succeeds on subsequent attempt', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Gateway Timeout', 504, {}, 'Gateway Timeout'))
                .mockResolvedValueOnce(jsonResponse({ recovered: true }));

            const { client } = makeClient();

            const result = await client.fetchJson<{ recovered: boolean }>(`${API_URL}/gateway-timeout`, {
                maxRetries: 2,
            });

            expect(result).toEqual({ recovered: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('retries on 502 Bad Gateway and succeeds on subsequent attempt', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'))
                .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'))
                .mockResolvedValueOnce(jsonResponse({ status: 'recovered' }));

            const { client } = makeClient();

            const result = await client.fetchJson<{ status: string }>(`${API_URL}/flaky`, { maxRetries: 3 });

            expect(result).toEqual({ status: 'recovered' });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('throws HttpException when maxRetries is exhausted on 503 Service Unavailable', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Service Unavailable', 503, {}, 'Service Unavailable'));

            const { client } = makeClient();

            await expect(client.fetchJson(`${API_URL}/down`, { maxRetries: 2 })).rejects.toMatchObject({
                status: 503,
            });

            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('does NOT retry non-retryable HTTP status codes (e.g. 400 Bad Request)', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ error: 'Invalid parameters' }, 400, {}, 'Bad Request'));

            const { client } = makeClient();

            await expect(client.fetchJson(`${API_URL}/bad-request`, { maxRetries: 3 })).rejects.toMatchObject({
                status: 400,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does NOT retry non-retryable HTTP 401 Unauthorized or 403 Forbidden', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Forbidden', 403, {}, 'Forbidden'));

            const { client } = makeClient();

            await expect(client.fetchJson(`${API_URL}/protected`)).rejects.toMatchObject({
                status: 403,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('BUG PREVENTER: does NOT retry 500 error on POST request by default (non-idempotent protection)', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Internal Server Error', 500, {}, 'Internal Server Error'));

            const { client } = makeClient();

            const body = JSON.stringify({ action: 'create' });

            await expect(
                client.fetchJson(`${API_URL}/mutate`, {
                    method: 'POST',
                    body,
                    maxRetries: 3,
                }),
            ).rejects.toMatchObject({
                status: 500,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [url, options] = fetchMock.mock.calls[0]!;

            expect(url).toBe(`${API_URL}/mutate`);
            expect(options).toMatchObject({
                method: 'POST',
                body,
            });
        });

        it('retries 500 error on POST request when idempotent: true is explicitly provided', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Server Error', 500, {}, 'Internal Server Error'))
                .mockResolvedValueOnce(jsonResponse({ created: true }));

            const { client } = makeClient();

            const result = await client.fetchJson<{ created: boolean }>(`${API_URL}/safe-mutate`, {
                method: 'POST',
                idempotent: true,
                maxRetries: 2,
            });

            expect(result).toEqual({ created: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);

            expect(fetchMock).toHaveBeenNthCalledWith(
                1,
                `${API_URL}/safe-mutate`,
                expect.objectContaining({
                    method: 'POST',
                }),
            );

            expect(fetchMock).toHaveBeenNthCalledWith(
                2,
                `${API_URL}/safe-mutate`,
                expect.objectContaining({
                    method: 'POST',
                }),
            );
        });

        it('retries 500 error on PUT request automatically (PUT is inherently idempotent)', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Server Error', 500, {}, 'Internal Server Error'))
                .mockResolvedValueOnce(jsonResponse({ updated: true }));

            const { client } = makeClient();

            const result = await client.fetchJson<{ updated: boolean }>(`${API_URL}/resource`, {
                method: 'PUT',
                maxRetries: 2,
            });

            expect(result).toEqual({ updated: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);

            expect(fetchMock).toHaveBeenNthCalledWith(
                1,
                `${API_URL}/resource`,
                expect.objectContaining({
                    method: 'PUT',
                }),
            );

            expect(fetchMock).toHaveBeenNthCalledWith(
                2,
                `${API_URL}/resource`,
                expect.objectContaining({
                    method: 'PUT',
                }),
            );
        });

        it('respects maxRetries: 1 override and performs exactly 1 attempt', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'));

            const { client } = makeClient();

            await expect(
                client.fetchJson(`${API_URL}/no-retries`, {
                    maxRetries: 1,
                }),
            ).rejects.toMatchObject({
                status: 502,
            });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('retries 429 response according to Retry-After header', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Rate Limited', 429, { 'Retry-After': '2' }, 'Too Many Requests'))
                .mockResolvedValueOnce(jsonResponse({ success: true }));

            const { client } = makeClient();

            const result = await client.fetchJson<{ success: boolean }>(`${API_URL}/rate-limited`, { maxRetries: 2 });

            expect(result).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('404 Handling', () => {
        it('returns null when allow404: true and endpoint returns HTTP 404', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ error: 'Not Found' }, 404, {}, 'Not Found'));

            const { client } = makeClient();

            const result = await client.fetchJson(`${API_URL}/missing-resource`, {
                allow404: true,
            });

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('throws HttpException on 404 when allow404 is omitted or false', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Not Found', 404, {}, 'Not Found'));

            const { client } = makeClient();

            await expect(client.fetchJson(`${API_URL}/missing-resource`)).rejects.toMatchObject({
                status: 404,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does NOT catch non-404 HTTP errors even when allow404: true is set', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Server Error', 500, {}, 'Internal Server Error'));

            const { client } = makeClient();

            await expect(
                client.fetchJson(`${API_URL}/error-resource`, {
                    allow404: true,
                    maxRetries: 0,
                }),
            ).rejects.toMatchObject({
                status: 500,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('returns null for 404 with allow404 even when response has a JSON body', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ error: 'Not Found', detail: 'resource gone' }, 404, {}, 'Not Found'));

            const { client } = makeClient();

            const result = await client.fetchJson(`${API_URL}/gone`, { allow404: true });

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('Null Return Contract', () => {
        it('returns null for 204 No Content instead of parsing JSON', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse(null, 204, {}, 'No Content'));

            const { client } = makeClient();

            const result = await client.fetchJson<{ id: number }>(`${API_URL}/empty`);

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('returns null for 404 when allow404 is enabled', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404, {}, 'Not Found'));

            const { client } = makeClient();

            const result = await client.fetchJson<{ message: string }>(`${API_URL}/missing`, { allow404: true });

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('typed as T | null so callers must handle the null case', async () => {
            // Runtime check: the value is null, not undefined or a thrown error.
            // Compile-time check: fetchJson<T> returns Promise<T | null>.
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse(null, 204, {}, 'No Content'));

            const { client } = makeClient();

            const result = await client.fetchJson<number>(`${API_URL}/no-body`);

            // If the return type were Promise<T>, this would be typed as number
            // and the caller could crash at runtime. With Promise<T | null>,
            // TypeScript forces a null check before use.
            expect(result).toBeNull();
            expect(typeof result).not.toBe('number');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('Network & Timeout Failures', () => {
        it('retries network failure exceptions up to the configured maximum number of total attempts (maxRetries)', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'))
                .mockResolvedValueOnce(jsonResponse({ ok: true }));

            const { client } = makeClient();

            const result = await client.fetchJson<{ ok: boolean }>(`${API_URL}/conn-reset`, { maxRetries: 2 });

            expect(result).toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('throws NetworkException after exhausting the configured maximum number of total attempts', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED'));

            const { client } = makeClient();

            await expect(
                client.fetchJson(`${API_URL}/unreachable`, {
                    maxRetries: 1,
                }),
            ).rejects.toBeInstanceOf(NetworkException);

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('rejects immediately with NetworkException when caller AbortSignal is pre-aborted', async () => {
            const fetchMock = jest.spyOn(globalThis, 'fetch');

            const { client } = makeClient();

            const controller = new AbortController();
            controller.abort();

            await expect(
                client.fetchJson(`${API_URL}/cancelled`, {
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({
                message: expect.stringContaining('cancelled'),
            });

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

            const { client } = makeClient();

            await expect(client.fetchJson(`${API_URL}/slow`, { timeoutMs: 50, maxRetries: 1 })).rejects.toBeInstanceOf(
                TimeoutException,
            );
        });

        it('throws NetworkException when caller aborts during request', async () => {
            const controller = new AbortController();

            jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
                return new Promise((_, reject) => {
                    const signal = init?.signal as AbortSignal | undefined;
                    let safetyTimer: NodeJS.Timeout | undefined;

                    if (signal) {
                        const onAbort = () => {
                            clearTimeout(safetyTimer); // <-- clean up the safety valve
                            reject(new DOMException('The operation was aborted.', 'AbortError'));
                        };

                        if (signal.aborted) {
                            onAbort();
                            return;
                        }
                        signal.addEventListener('abort', onAbort, { once: true });
                    }

                    // If nothing happens in 1 s, force-fail (shorter = less leak risk)
                    safetyTimer = setTimeout(() => reject(new Error('should not reach')), 1000);
                });
            });

            const { client } = makeClient();

            setTimeout(() => controller.abort(), 10);

            await expect(
                client.fetchJson(`${API_URL}/slow`, {
                    signal: controller.signal,
                    maxRetries: 1,
                }),
            ).rejects.toMatchObject({
                message: expect.stringContaining('cancelled'),
            });
        });

        it('throttles requests when useRateLimit is enabled', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));

            const fakes = createFakes();
            const { client } = makeClient({
                useRateLimit: true,
                rateLimitCapacity: 1,
                rateLimitWindow: 100, // 1 token per 100 ms
                sleep: fakes.sleep,
                random: fakes.random,
                clock: fakes.clock,
            });

            const timeBefore = fakes.clock.now();
            await client.fetchJson(`${API_URL}/a`);
            await client.fetchJson(`${API_URL}/b`);
            const timeAfter = fakes.clock.now();

            expect(timeAfter - timeBefore).toBe(100); // точно 100ms, не >= 50
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('Endpoint Lifecycle & Resource Management', () => {
        it('handles sequential requests through a single direct endpoint', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse({ ep: 1 }))
                .mockResolvedValueOnce(jsonResponse({ ep: 2 }));

            const { client } = makeClient({
                proxyUrls: `${ENDPOINT_1},${ENDPOINT_2}`,
            });

            const first = await client.fetchJson<{ ep: number }>(`${API_URL}/req1`);
            const second = await client.fetchJson<{ ep: number }>(`${API_URL}/req2`);

            expect(first).toEqual({ ep: 1 });
            expect(second).toEqual({ ep: 2 });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('closes all endpoints cleanly when client.close() is called', async () => {
            const transport = new FetchDirectTransport();
            const closeSpy = jest.spyOn(transport, 'close');

            const transportFactory = new FetchDirectTransportFactory();
            jest.spyOn(transportFactory, 'create').mockReturnValue(transport);

            const provider = new DirectEndpointProvider(transportFactory);
            const client = createHttpClient(createDefaultOptions(), provider);

            await client.close();

            expect(closeSpy).toHaveBeenCalledTimes(1);
        });
    });
});
