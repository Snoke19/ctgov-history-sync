import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { API_URL, jsonResponse, withClient } from './helpers.js';

function mockResponse(
    status: number,
    body: unknown,
    statusText: string,
    headers: Record<string, string> = {},
): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status, headers, statusText));
}

describe('HttpClient retry policy', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('retries 408 Request Timeout', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Request Timeout', 408, {}, 'Request Timeout'))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));

        await withClient(async (client) => {
            const result = await client.fetchJson<{ recovered: boolean }>(`${API_URL}/request-timeout`, {
                maxRetries: 1,
            });

            expect(result).toEqual({ recovered: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it('retries 429 with Retry-After HTTP-date', async () => {
        const futureDate = new Date(Date.now() + 2000).toUTCString();

        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                jsonResponse('Rate Limited', 429, { 'Retry-After': futureDate }, 'Too Many Requests'),
            )
            .mockResolvedValueOnce(jsonResponse({ success: true }));

        await withClient(async (client) => {
            const result = await client.fetchJson<{ success: boolean }>(`${API_URL}/rate-limited-date`, {
                maxRetries: 2,
            });

            expect(result).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it('performs exactly one attempt when maxRetries is 0', async () => {
        const fetchMock = mockResponse(502, 'Bad Gateway', 'Bad Gateway');

        await withClient(async (client) => {
            await expect(
                client.fetchJson(`${API_URL}/no-retry`, {
                    maxRetries: 0,
                }),
            ).rejects.toMatchObject({
                status: 502,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('retries 504 Gateway Timeout and succeeds on the next attempt', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Gateway Timeout', 504, {}, 'Gateway Timeout'))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));

        await withClient(async (client) => {
            const result = await client.fetchJson<{ recovered: boolean }>(`${API_URL}/gateway-timeout`, {
                maxRetries: 2,
            });

            expect(result).toEqual({ recovered: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it('retries 502 Bad Gateway until the request succeeds', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'))
            .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'))
            .mockResolvedValueOnce(jsonResponse({ status: 'recovered' }));

        await withClient(async (client) => {
            const result = await client.fetchJson<{ status: string }>(`${API_URL}/flaky`, {
                maxRetries: 3,
            });

            expect(result).toEqual({ status: 'recovered' });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });
    });

    it('throws HttpException when retries are exhausted on 503 Service Unavailable', async () => {
        const fetchMock = mockResponse(503, 'Service Unavailable', 'Service Unavailable');

        await withClient(async (client) => {
            await expect(
                client.fetchJson(`${API_URL}/down`, {
                    maxRetries: 2,
                }),
            ).rejects.toMatchObject({
                status: 503,
            });

            expect(fetchMock).toHaveBeenCalledTimes(3);
        });
    });

    it('does not retry non-retryable HTTP status 400 Bad Request', async () => {
        const fetchMock = mockResponse(400, { error: 'Invalid parameters' }, 'Bad Request');

        await withClient(async (client) => {
            await expect(
                client.fetchJson(`${API_URL}/bad-request`, {
                    maxRetries: 3,
                }),
            ).rejects.toMatchObject({
                status: 400,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('does not retry non-retryable HTTP status 403 Forbidden', async () => {
        const fetchMock = mockResponse(403, 'Forbidden', 'Forbidden');

        await withClient(async (client) => {
            await expect(client.fetchJson(`${API_URL}/protected`)).rejects.toMatchObject({
                status: 403,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('performs exactly two attempts when maxRetries is 1', async () => {
        const fetchMock = mockResponse(502, 'Bad Gateway', 'Bad Gateway');

        await withClient(async (client) => {
            await expect(
                client.fetchJson(`${API_URL}/no-retries`, {
                    maxRetries: 1,
                }),
            ).rejects.toMatchObject({
                status: 502,
            });

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it('retries 429 according to Retry-After delay-seconds', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Rate Limited', 429, { 'Retry-After': '2' }, 'Too Many Requests'))
            .mockResolvedValueOnce(jsonResponse({ success: true }));

        await withClient(async (client) => {
            const result = await client.fetchJson<{ success: boolean }>(`${API_URL}/rate-limited`, {
                maxRetries: 2,
            });

            expect(result).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });
});
