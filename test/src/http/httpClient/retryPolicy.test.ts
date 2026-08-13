import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { API_URL, jsonResponse, makeClient } from './helpers.js';

describe('HttpClient retry policy', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('retries 408 Request Timeout', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Request Timeout', 408, {}, 'Request Timeout'))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));

        const client = await makeClient();

        const result = await client.fetchJson<{ recovered: boolean }>(`${API_URL}/request-timeout`, {
            maxRetries: 1,
        });

        expect(result).toEqual({ recovered: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries 429 with Retry-After HTTP-date format', async () => {
        const futureDate = new Date(Date.now() + 2000).toUTCString();

        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                jsonResponse('Rate Limited', 429, { 'Retry-After': futureDate }, 'Too Many Requests'),
            )
            .mockResolvedValueOnce(jsonResponse({ success: true }));

        const client = await makeClient();

        const result = await client.fetchJson<{ success: boolean }>(`${API_URL}/rate-limited-date`, {
            maxRetries: 2,
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('performs exactly one attempt when maxRetries is 0', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'));

        const client = await makeClient();

        await expect(client.fetchJson(`${API_URL}/no-retry`, { maxRetries: 0 })).rejects.toMatchObject({ status: 502 });

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe('Retry Policy', () => {
        it('retries on 504 Gateway Timeout and succeeds on subsequent attempt', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Gateway Timeout', 504, {}, 'Gateway Timeout'))
                .mockResolvedValueOnce(jsonResponse({ recovered: true }));

            const client = await makeClient();

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

            const client = await makeClient();

            const result = await client.fetchJson<{ status: string }>(`${API_URL}/flaky`, { maxRetries: 3 });

            expect(result).toEqual({ status: 'recovered' });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('throws HttpException when maxRetries is exhausted on 503 Service Unavailable', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Service Unavailable', 503, {}, 'Service Unavailable'));

            const client = await makeClient();

            await expect(client.fetchJson(`${API_URL}/down`, { maxRetries: 2 })).rejects.toMatchObject({
                status: 503,
            });

            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('does NOT retry non-retryable HTTP status codes (e.g. 400 Bad Request)', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ error: 'Invalid parameters' }, 400, {}, 'Bad Request'));

            const client = await makeClient();

            await expect(client.fetchJson(`${API_URL}/bad-request`, { maxRetries: 3 })).rejects.toMatchObject({
                status: 400,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does NOT retry non-retryable HTTP 401 Unauthorized or 403 Forbidden', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Forbidden', 403, {}, 'Forbidden'));

            const client = await makeClient();

            await expect(client.fetchJson(`${API_URL}/protected`)).rejects.toMatchObject({
                status: 403,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('respects maxRetries: 1 and performs exactly 2 total attempts (1 initial + 1 retry)', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'));

            const client = await makeClient();

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

            const client = await makeClient();

            const result = await client.fetchJson<{ success: boolean }>(`${API_URL}/rate-limited`, { maxRetries: 2 });

            expect(result).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });
});
