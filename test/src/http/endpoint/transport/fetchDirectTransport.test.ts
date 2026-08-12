import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FetchDirectTransport } from '../../../../../src/http/endpoint/transport/impl/fetchDirectTransport.js';

function createMockResponse(overrides: Partial<Response> = {}): Response {
    return {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers(),
        body: {
            cancel: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as ReadableStream<Uint8Array>,
        text: jest.fn<() => Promise<string>>().mockResolvedValue(''),
        json: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
        ...overrides,
    } as unknown as Response;
}

describe('FetchDirectTransport', () => {
    let transport: FetchDirectTransport;
    let fetchMock: jest.Mock<typeof fetch>;

    beforeEach(() => {
        transport = new FetchDirectTransport();
        fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('request', () => {
        it('calls fetch with url, method, and headers', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: { 'X-Custom': 'value' },
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', {
                method: 'GET',
                headers: { 'X-Custom': 'value' },
            });
        });

        it('does not include body when undefined', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            const [, fetchOptions] = fetchMock.mock.calls[0] as [unknown, RequestInit];
            expect(fetchOptions).not.toHaveProperty('body');
        });

        it('includes body when provided', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            await transport.request({
                url: 'https://example.com/api',
                method: 'POST',
                headers: {},
                body: '{"key":"value"}',
            });

            const [, fetchOptions] = fetchMock.mock.calls[0] as [unknown, RequestInit];
            expect(fetchOptions).toHaveProperty('body', '{"key":"value"}');
        });

        it('does not include signal when undefined', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            const [, fetchOptions] = fetchMock.mock.calls[0] as [unknown, RequestInit];
            expect(fetchOptions).not.toHaveProperty('signal');
        });

        it('includes signal when provided', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);
            const controller = new AbortController();

            await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
                signal: controller.signal,
            });

            const [, fetchOptions] = fetchMock.mock.calls[0] as [unknown, RequestInit];
            expect(fetchOptions).toHaveProperty('signal', controller.signal);
        });

        it('maps response fields correctly', async () => {
            const mockHeaders = new Headers({ 'content-type': 'application/json' });
            const mockResponse = createMockResponse({
                status: 201,
                statusText: 'Created',
                ok: true,
                headers: mockHeaders,
            });
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            const result = await transport.request({
                url: 'https://example.com/api',
                method: 'POST',
                headers: {},
            });

            expect(result.status).toBe(201);
            expect(result.statusText).toBe('Created');
            expect(result.ok).toBe(true);
            expect(result.headers).toBe(mockHeaders);
        });

        it('exposes text() that delegates to response.text()', async () => {
            const mockResponse = createMockResponse({
                text: jest.fn<() => Promise<string>>().mockResolvedValue('raw text'),
            });
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            const result = await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            const text = await result.text();
            expect(text).toBe('raw text');
            expect(mockResponse.text).toHaveBeenCalledTimes(1);
        });

        it('exposes json() that delegates to response.json()', async () => {
            const mockResponse = createMockResponse({
                json: jest.fn<() => Promise<unknown>>().mockResolvedValue({ data: 42 }),
            });
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            const result = await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            const json = await result.json();
            expect(json).toEqual({ data: 42 });
            expect(mockResponse.json).toHaveBeenCalledTimes(1);
        });

        it('discard() cancels the response body when present', async () => {
            const cancelMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
            const mockResponse = createMockResponse({
                body: { cancel: cancelMock } as unknown as ReadableStream<Uint8Array>,
            });
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            const result = await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            await result.discard();
            expect(cancelMock).toHaveBeenCalledTimes(1);
        });

        it('discard() does not throw when body is null', async () => {
            const mockResponse = createMockResponse({
                body: null,
            });
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            const result = await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            await expect(result.discard()).resolves.toBeUndefined();
        });

        it('discard() swallows cancellation errors', async () => {
            const cancelMock = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Abort'));
            const mockResponse = createMockResponse({
                body: { cancel: cancelMock } as unknown as ReadableStream<Uint8Array>,
            });
            fetchMock.mockResolvedValue(mockResponse as unknown as Response);

            const result = await transport.request({
                url: 'https://example.com/api',
                method: 'GET',
                headers: {},
            });

            await expect(result.discard()).resolves.toBeUndefined();
        });
    });

    describe('classifyError', () => {
        it('classifies a DOMException AbortError as cancelled', () => {
            const error = new DOMException('The operation was aborted.', 'AbortError');

            expect(transport.classifyError(error)).toEqual({ kind: 'cancelled', cause: error });
        });

        it('classifies an AbortError-named error as cancelled', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';

            expect(transport.classifyError(error)).toEqual({ kind: 'cancelled', cause: error });
        });

        it('classifies an ABORT_ERR-code error as cancelled', () => {
            const error = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });

            expect(transport.classifyError(error)).toEqual({ kind: 'cancelled', cause: error });
        });

        it('classifies everything else as a network failure', () => {
            const error = new TypeError('fetch failed: ECONNRESET');

            expect(transport.classifyError(error)).toEqual({ kind: 'network', cause: error });
        });
    });
});
