import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { API_URL, jsonResponse, withClient } from './helpers.js';

function mockResponse(status: number, body: unknown, statusText: string): jest.SpiedFunction<typeof fetch> {
    return jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, status, {}, statusText));
}

function mock404Response(body: unknown): jest.SpiedFunction<typeof fetch> {
    return mockResponse(404, body, 'Not Found');
}

function mock204Response(): jest.SpiedFunction<typeof fetch> {
    return mockResponse(204, null, 'No Content');
}

describe('HttpClient 404 & null handling', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('404 Handling', () => {
        it('returns null when allow404 is true and endpoint returns HTTP 404', async () => {
            const fetchMock = mock404Response({ error: 'Not Found' });

            await withClient(async (client) => {
                const result = await client.fetchJson(`${API_URL}/missing-resource`, {
                    allow404: true,
                });

                expect(result).toBeNull();
                expect(fetchMock).toHaveBeenCalledTimes(1);
            });
        });

        it('throws HttpException on 404 when allow404 is omitted or false', async () => {
            const fetchMock = mock404Response('Not Found');

            await withClient(async (client) => {
                await expect(client.fetchJson(`${API_URL}/missing-resource`)).rejects.toMatchObject({
                    status: 404,
                });

                expect(fetchMock).toHaveBeenCalledTimes(1);
            });
        });

        it('does NOT catch non-404 HTTP errors even when allow404 is true', async () => {
            const fetchMock = mockResponse(500, 'Server Error', 'Internal Server Error');

            await withClient(async (client) => {
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
        });

        it('returns null for 404 with allow404 even when response has a JSON body', async () => {
            const fetchMock = mock404Response({
                error: 'Not Found',
                detail: 'resource gone',
            });

            await withClient(async (client) => {
                const result = await client.fetchJson(`${API_URL}/gone`, {
                    allow404: true,
                });

                expect(result).toBeNull();
                expect(fetchMock).toHaveBeenCalledTimes(1);
            });
        });

        it('returns null for 404 when it arrives on a retry attempt and allow404 is true', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Service Unavailable', 503, {}, 'Service Unavailable'))
                .mockResolvedValueOnce(jsonResponse({ error: 'Not Found' }, 404, {}, 'Not Found'));

            await withClient(async (client) => {
                const result = await client.fetchJson(`${API_URL}/transient-then-404`, {
                    allow404: true,
                    maxRetries: 2,
                });

                expect(result).toBeNull();
                expect(fetchMock).toHaveBeenCalledTimes(2);
            });
        });

        it('throws when per-request retryPolicy includes 404 in retryableStatusCodes', async () => {
            await withClient(async (client) => {
                await expect(
                    client.fetchJson(`${API_URL}/invariant`, {
                        retryPolicy: { retryableStatusCodes: new Set([404]) },
                    }),
                ).rejects.toThrow('404 must not be in retryableStatusCodes');
            });
        });
    });

    describe('Null Return Contract', () => {
        it('returns null for 204 No Content instead of parsing JSON', async () => {
            const fetchMock = mock204Response();

            await withClient(async (client) => {
                const result = await client.fetchJson<{ id: number }>(`${API_URL}/empty`);

                expect(result).toBeNull();
                expect(fetchMock).toHaveBeenCalledTimes(1);
            });
        });
    });
});
