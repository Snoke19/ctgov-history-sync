import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ApiResponseValidationError } from '../../../../src/error/errors.js';
import type { HttpResponse } from '../../../../src/http/transport/httpTransport.js';
import { FetchDirectTransport } from '../../../../src/http/transport/impl/fetchDirectTransport.js';
import { API_URL, jsonResponse, withClient } from './helpers.js';

describe('HttpClient happy path & request construction', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('performs exactly one attempt and zero retries when maxRetries is 0', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'));

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

    it('performs three total attempts when maxRetries is 2', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'))
            .mockResolvedValueOnce(jsonResponse('Bad Gateway', 502, {}, 'Bad Gateway'))
            .mockResolvedValueOnce(jsonResponse({ recovered: true }));

        await withClient(async (client) => {
            const result = await client.fetchJson<{ recovered: boolean }>(`${API_URL}/retry-twice`, {
                maxRetries: 2,
            });

            expect(result).toEqual({ recovered: true });
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });
    });

    it('allows custom headers to override Accept and User-Agent defaults', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

        await withClient(async (client) => {
            await client.fetchJson(`${API_URL}/headers`, {
                headers: {
                    Accept: 'text/plain',
                    'User-Agent': 'CustomAgent/1.0',
                    'X-Custom': 'value',
                },
            });

            expect(fetchMock).toHaveBeenCalledWith(
                `${API_URL}/headers`,
                expect.objectContaining({
                    headers: {
                        Accept: 'text/plain',
                        'User-Agent': 'CustomAgent/1.0',
                        'X-Custom': 'value',
                    },
                }),
            );
        });
    });

    it('fully replaces the default Accept header with a custom override', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));

        await withClient(async (client) => {
            await client.fetchJson(`${API_URL}/accept-replace`, {
                headers: { Accept: 'text/plain' },
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const requestInit = fetchMock.mock.calls[0]?.[1];
            const serializedHeaders = JSON.stringify(requestInit?.headers) ?? '';

            expect(serializedHeaders).toContain('text/plain');
            expect(serializedHeaders).not.toContain('application/json');
        });
    });

    it('fetches and parses JSON payload successfully for 200 OK', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse({
                id: 101,
                title: 'Clinical Trial #1',
            }),
        );

        await withClient(async (client) => {
            const result = await client.fetchJson<{ id: number; title: string }>(`${API_URL}/trials/101`);

            expect(result).toEqual({
                id: 101,
                title: 'Clinical Trial #1',
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('returns null for 204 No Content response without attempting JSON parse', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(null, 204, {}, 'No Content'));

        await withClient(async (client) => {
            const result = await client.fetchJson(`${API_URL}/trials/empty`);

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    it('drains 204 No Content without calling json()', async () => {
        const json = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('json must not be called'));
        const discard = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

        jest.spyOn(FetchDirectTransport.prototype, 'request').mockResolvedValue({
            status: 204,
            statusText: 'No Content',
            ok: true,
            headers: new Headers(),
            text: jest.fn<() => Promise<string>>().mockRejectedValue(new Error('text must not be called')),
            json,
            discard,
        } as HttpResponse);

        await withClient(async (client) => {
            const result = await client.fetchJson(`${API_URL}/no-body-drained`);

            expect(result).toBeNull();
            expect(json).not.toHaveBeenCalled();
            expect(discard).toHaveBeenCalledTimes(1);
        });
    });

    it('throws ApiResponseValidationError when 200 OK response contains invalid JSON body', async () => {
        jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('invalid json', {
                status: 200,
                statusText: 'OK',
                headers: {
                    'content-type': 'application/json',
                },
            }),
        );

        await withClient(async (client) => {
            const promise = client.fetchJson(`${API_URL}/bad-json`);

            await expect(promise).rejects.toBeInstanceOf(ApiResponseValidationError);
            await expect(promise).rejects.toMatchObject({
                url: `${API_URL}/bad-json`,
                message: `Invalid API response from ${API_URL}/bad-json: Invalid JSON response: SyntaxError: Unexpected token 'i', "invalid json" is not valid JSON`,
            });
        });
    });
});
