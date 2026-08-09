import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { HttpRequest } from '../../../../../src/http/endpoint/transport/httpTransport.js';
import type { ProxyAgent, Response } from 'undici';

const mockFetch = jest.fn<(url: string, options?: RequestInit) => Promise<Response>>();

jest.unstable_mockModule('undici', () => ({
    fetch: mockFetch,
    ProxyAgent: class {},
}));

jest.unstable_mockModule('../../../../../src/http/endpoint/proxy/resolveConnections.js', () => ({
    resolveConnections: jest.fn(),
}));

jest.unstable_mockModule('../../../../../src/http/poolFactory.js', () => ({
    createPoolFactory: jest.fn(),
}));

const { UndiciHttpTransport } = await import('../../../../../src/http/endpoint/transport/impl/undiciProxyTransport.js');

function makeRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
    return {
        url: 'https://api.example.com/resource',
        method: 'GET',
        headers: {
            Authorization: 'Bearer test-token',
        },
        ...overrides,
    };
}

function makeFakeResponse(overrides: Partial<Response> = {}): Response {
    return {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({
            'content-type': 'application/json',
        }),
        body: null,
        text: jest.fn<() => Promise<string>>().mockResolvedValue('response body text'),
        json: jest.fn<() => Promise<unknown>>().mockResolvedValue({ result: 'ok' }),
        ...overrides,
    } as unknown as Response;
}

function makeFakeAgent() {
    return {
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
}

describe('UndiciHttpTransport', () => {
    let fakeAgent: ReturnType<typeof makeFakeAgent>;
    let transport: InstanceType<typeof UndiciHttpTransport>;

    beforeEach(() => {
        fakeAgent = makeFakeAgent();

        mockFetch.mockResolvedValue(makeFakeResponse());

        transport = new UndiciHttpTransport(fakeAgent as unknown as ProxyAgent);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('request()', () => {
        it('passes url and method to fetch', async () => {
            await transport.request(makeRequest({ url: 'https://target.com/api', method: 'DELETE' }));

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockFetch).toHaveBeenCalledWith(
                'https://target.com/api',
                expect.objectContaining({ method: 'DELETE' }),
            );
        });

        it('passes headers to fetch', async () => {
            const headers = { 'x-request-id': 'abc123', Authorization: 'Bearer xyz' };

            await transport.request(makeRequest({ headers }));

            expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers }));
        });

        it('wires the injected agent as the fetch dispatcher', async () => {
            await transport.request(makeRequest());

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ dispatcher: fakeAgent }),
            );
        });

        it('includes body in fetch options when provided', async () => {
            const body = '{"foo":"bar"}';

            await transport.request(makeRequest({ body }));

            expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body }));
        });

        it('omits body key entirely when body is undefined', async () => {
            await transport.request(makeRequest({ body: undefined }));

            const [, opts] = mockFetch.mock.calls[0]!;
            expect(opts).not.toHaveProperty('body');
        });

        it('includes signal in fetch options when provided', async () => {
            const { signal } = new AbortController();

            await transport.request(makeRequest({ signal }));

            expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }));
        });

        it('maps status, statusText, ok, and headers from the fetch response', async () => {
            const headers = new Headers({ 'x-rate-limit-remaining': '42' });
            mockFetch.mockResolvedValue(
                makeFakeResponse({ status: 404, statusText: 'Not Found', ok: false, headers }) as any,
            );

            const result = await transport.request(makeRequest());

            expect(result.status).toBe(404);
            expect(result.statusText).toBe('Not Found');
            expect(result.ok).toBe(false);
            expect(result.headers).toBe(headers);
        });

        it('text() delegates to the underlying fetch response', async () => {
            const fakeResponse = makeFakeResponse();

            mockFetch.mockResolvedValue(fakeResponse);

            const result = await transport.request(makeRequest());
            const text = await result.text();

            expect(fakeResponse.text).toHaveBeenCalledTimes(1);
            expect(text).toBe('response body text');
        });

        it('json() delegates to the underlying fetch response', async () => {
            const fakeResponse = makeFakeResponse();

            mockFetch.mockResolvedValue(fakeResponse);

            const result = await transport.request(makeRequest());
            const json = await result.json();

            expect(fakeResponse.json).toHaveBeenCalledTimes(1);
            expect(json).toEqual({ result: 'ok' });
        });

        describe('discard()', () => {
            it('cancels the body ReadableStream when body is non-null', async () => {
                const cancel = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
                mockFetch.mockResolvedValue(makeFakeResponse({ body: { cancel } as unknown as ReadableStream }) as any);

                const result = await transport.request(makeRequest());
                await result.discard();

                expect(cancel).toHaveBeenCalledTimes(1);
            });

            it('is a no-op when body is null', async () => {
                mockFetch.mockResolvedValue(makeFakeResponse({ body: null }) as any);

                const result = await transport.request(makeRequest());

                await expect(result.discard()).resolves.toBeUndefined();
            });

            it('swallows errors thrown during stream cancellation', async () => {
                const cancel = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('stream already closed'));
                mockFetch.mockResolvedValue(makeFakeResponse({ body: { cancel } as unknown as ReadableStream }) as any);

                const result = await transport.request(makeRequest());

                await expect(result.discard()).resolves.toBeUndefined();
            });
        });
    });

    describe('close()', () => {
        it('delegates to the underlying agent', async () => {
            await transport.close();

            expect(fakeAgent.close).toHaveBeenCalledTimes(1);
        });

        it('forwards the resolved value from agent.close()', async () => {
            await expect(transport.close()).resolves.toBeUndefined();
        });
    });
});
