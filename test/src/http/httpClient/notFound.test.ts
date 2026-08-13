import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { API_URL, jsonResponse, makeClient } from './helpers.js';

describe('HttpClient 404 & null handling', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('404 Handling', () => {
        it('returns null when allow404: true and endpoint returns HTTP 404', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ error: 'Not Found' }, 404, {}, 'Not Found'));

            const client = await makeClient();

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

            const client = await makeClient();

            await expect(client.fetchJson(`${API_URL}/missing-resource`)).rejects.toMatchObject({
                status: 404,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does NOT catch non-404 HTTP errors even when allow404: true is set', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse('Server Error', 500, {}, 'Internal Server Error'));

            const client = await makeClient();

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

            const client = await makeClient();

            const result = await client.fetchJson(`${API_URL}/gone`, { allow404: true });

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('returns null for 404 when it arrives on a retry attempt and allow404 is true', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValueOnce(jsonResponse('Service Unavailable', 503, {}, 'Service Unavailable'))
                .mockResolvedValueOnce(jsonResponse({ error: 'Not Found' }, 404, {}, 'Not Found'));

            const client = await makeClient();

            const result = await client.fetchJson(`${API_URL}/transient-then-404`, {
                allow404: true,
                maxRetries: 2,
            });

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('throws when per-request retryPolicy includes 404 in retryableStatusCodes', async () => {
            const client = await makeClient();

            await expect(
                client.fetchJson(`${API_URL}/invariant`, {
                    retryPolicy: { retryableStatusCodes: new Set([404]) },
                }),
            ).rejects.toThrow('404 must not be in retryableStatusCodes');
        });
    });

    describe('Null Return Contract', () => {
        it('returns null for 204 No Content instead of parsing JSON', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse(null, 204, {}, 'No Content'));

            const client = await makeClient();

            const result = await client.fetchJson<{ id: number }>(`${API_URL}/empty`);

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('returns null for 404 when allow404 is enabled', async () => {
            const fetchMock = jest
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(jsonResponse({ message: 'Not Found' }, 404, {}, 'Not Found'));

            const client = await makeClient();

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

            const client = await makeClient();

            const result = await client.fetchJson<number>(`${API_URL}/no-body`);

            // If the return type were Promise<T>, this would be typed as number
            // and the caller could crash at runtime. With Promise<T | null>,
            // TypeScript forces a null check before use.
            expect(result).toBeNull();
            expect(typeof result).not.toBe('number');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });
});
