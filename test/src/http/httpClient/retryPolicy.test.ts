import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { API_URL } from '../../fixtures/constants.js';
import { withClient } from '../../fixtures/lifecycle.fixture.js';
import { jsonResponse } from '../../fixtures/response.fixture.js';

function mockResponse(
    status: number,
    body: unknown,
    statusText: string,
    headers: Record<string, string> = {},
): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status, headers, statusText));
}

describe('HttpClient retry integration', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('maxRetries → attempts', () => {
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

        it('performs exactly two attempts when maxRetries is 1', async () => {
            const fetchMock = mockResponse(502, 'Bad Gateway', 'Bad Gateway');

            await withClient(async (client) => {
                await expect(
                    client.fetchJson(`${API_URL}/one-retry`, {
                        maxRetries: 1,
                    }),
                ).rejects.toMatchObject({
                    status: 502,
                });

                expect(fetchMock).toHaveBeenCalledTimes(2);
            });
        });
    });

    describe('retryable HTTP failure → retry', () => {
        it('retries a retryable HTTP failure and returns the successful result', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Internal Server Error', 500, {}, 'Internal Server Error'))
                .mockResolvedValueOnce(jsonResponse({ recovered: true }));

            await withClient(async (client) => {
                const result = await client.fetchJson<{ recovered: boolean }>(`${API_URL}/retryable-failure`, {
                    maxRetries: 1,
                });

                expect(result).toEqual({ recovered: true });
                expect(fetchMock).toHaveBeenCalledTimes(2);
            });
        });
    });

    describe('non-retryable HTTP failure → no retry', () => {
        it('does not retry a non-retryable HTTP failure', async () => {
            const fetchMock = mockResponse(404, 'Not Found', 'Not Found');

            await withClient(async (client) => {
                await expect(
                    client.fetchJson(`${API_URL}/not-found`, {
                        maxRetries: 3,
                    }),
                ).rejects.toMatchObject({
                    status: 404,
                });

                expect(fetchMock).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('Retry-After → HTTP retry', () => {
        it('retries a 429 response with Retry-After delay-seconds', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Rate Limited', 429, { 'Retry-After': '2' }, 'Too Many Requests'))
                .mockResolvedValueOnce(jsonResponse({ success: true }));

            await withClient(async (client) => {
                const result = await client.fetchJson<{ success: boolean }>(`${API_URL}/rate-limited`, {
                    maxRetries: 1,
                });

                expect(result).toEqual({ success: true });
                expect(fetchMock).toHaveBeenCalledTimes(2);
            });
        });
    });
});
