import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { TrialFetchError } from '../../../../src/error/errors.js';
import type { HttpResponse } from '../../../../src/http/endpoint/transport/httpTransport.js';
import { FetchDirectTransport } from '../../../../src/http/endpoint/transport/impl/fetchDirectTransport.js';
import { API_URL, jsonResponse, makeClient } from './helpers.js';

describe('HttpClient happy path & request construction', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('allows custom headers to override Accept and User-Agent defaults', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
        const client = makeClient();

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

    it('fully replaces the default Accept header with a custom override (no merge)', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }));
        const client = makeClient();

        await client.fetchJson(`${API_URL}/accept-replace`, {
            headers: { Accept: 'text/plain' },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const requestInit = fetchMock.mock.calls[0]?.[1];
        const serializedHeaders = JSON.stringify(requestInit?.headers) ?? '';

        expect(serializedHeaders).toContain('text/plain');
        expect(serializedHeaders).not.toContain('application/json');
    });

    it('throws TrialFetchError and does NOT retry on invalid JSON body', async () => {
        const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response('500 Internal Server Error', {
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
            }),
        );

        const client = makeClient();

        await expect(client.fetchJson(`${API_URL}/bad-json`)).rejects.toBeInstanceOf(TrialFetchError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe('Happy Path & Response Parsing', () => {
        it('fetches and parses JSON payload successfully for 200 OK', async () => {
            const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
                jsonResponse({
                    id: 101,
                    title: 'Clinical Trial #1',
                }),
            );

            const client = makeClient();

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

            const client = makeClient();

            const result = await client.fetchJson(`${API_URL}/trials/empty`);

            expect(result).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('204 response is drained without ever calling json(), even if json() would throw', async () => {
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

            const client = makeClient();

            const result = await client.fetchJson(`${API_URL}/no-body-drained`);

            expect(result).toBeNull();
            expect(json).not.toHaveBeenCalled();
            expect(discard).toHaveBeenCalledTimes(1);
        });

        it('forwards custom HTTP method, headers, and request body to transport', async () => {
            const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ success: true }));

            const client = makeClient();

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

            const client = makeClient();

            await expect(client.fetchJson(`${API_URL}/bad-json`)).rejects.toBeInstanceOf(TrialFetchError);
        });
    });
});