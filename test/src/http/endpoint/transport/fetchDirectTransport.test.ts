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

    it('close() resolves successfully', async () => {
        await expect(transport.close()).resolves.toBeUndefined();
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
    });
});
