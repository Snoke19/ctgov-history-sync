import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ProxyAgent, Response } from 'undici';
import type { HttpRequest } from '../../../../../src/http/endpoint/transport/httpTransport.js';

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
        headers: { Authorization: 'Bearer test-token' },
        ...overrides,
    };
}

// Record<string, unknown> lets us override body with fake streams without `as any`
function makeFakeResponse(overrides: Record<string, unknown> = {}): Response {
    return {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
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

    function getLastFetchOpts(): RequestInit | undefined {
        return mockFetch.mock.calls[mockFetch.mock.calls.length - 1]![1];
    }

    describe('request()', () => {
        it('includes empty string body', async () => {
            await transport.request(makeRequest({ body: '' }));
            expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: '' }));
        });

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

        it('includes body when provided', async () => {
            await transport.request(makeRequest({ body: '{"foo":"bar"}' }));

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ body: '{"foo":"bar"}' }),
            );
        });

        it('omits body key when body is undefined', async () => {
            await transport.request(makeRequest({ body: undefined }));

            expect(getLastFetchOpts()).not.toHaveProperty('body');
        });

        it('includes signal when provided', async () => {
            const { signal } = new AbortController();
            await transport.request(makeRequest({ signal }));

            expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }));
        });

        it('omits signal key by default', async () => {
            await transport.request(makeRequest());
            expect(getLastFetchOpts()).not.toHaveProperty('signal');
        });

        it('propagates fetch errors', async () => {
            mockFetch.mockRejectedValue(new Error('network failure'));

            await expect(transport.request(makeRequest())).rejects.toThrow('network failure');
        });
    });

    describe('close()', () => {
        it('delegates to the underlying agent', async () => {
            await transport.close();

            expect(fakeAgent.close).toHaveBeenCalledTimes(1);
        });

        it('returns the resolved value from agent.close()', async () => {
            await expect(transport.close()).resolves.toBeUndefined();
        });

        it('propagates agent.close() rejection', async () => {
            fakeAgent.close.mockRejectedValue(new Error('close failed'));

            await expect(transport.close()).rejects.toThrow('close failed');
        });
    });
});
