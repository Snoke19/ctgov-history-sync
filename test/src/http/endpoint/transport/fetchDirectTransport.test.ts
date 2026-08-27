import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HTTP_METHOD_GET } from '../../../../../src/http/http.js';
import { FetchDirectTransport } from '../../../../../src/http/transport/impl/fetchDirectTransport.js';

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
        it('calls fetch with url, method, headers, and signal', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse);

            const controller = new AbortController();

            await transport.request({
                url: 'https://example.com/api',
                method: HTTP_METHOD_GET,
                headers: { 'X-Custom': 'value' },
                requestAbortSignal: controller.signal,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', {
                method: HTTP_METHOD_GET,
                headers: { 'X-Custom': 'value' },
                signal: controller.signal,
            });
        });

        it('forwards the request signal to fetch', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse);

            const controller = new AbortController();

            await transport.request({
                url: 'https://example.com/api',
                method: HTTP_METHOD_GET,
                headers: {},
                requestAbortSignal: controller.signal,
            });

            const [, fetchOptions] = fetchMock.mock.calls[0] as [unknown, RequestInit];

            expect(fetchOptions).toHaveProperty('signal', controller.signal);
        });

        it('forwards an already-aborted signal to fetch', async () => {
            const mockResponse = createMockResponse();
            fetchMock.mockResolvedValue(mockResponse);

            const controller = new AbortController();
            controller.abort();

            await transport.request({
                url: 'https://example.com/api',
                method: HTTP_METHOD_GET,
                headers: {},
                requestAbortSignal: controller.signal,
            });

            const [, fetchOptions] = fetchMock.mock.calls[0] as [unknown, RequestInit];

            expect(fetchOptions).toHaveProperty('signal', controller.signal);
            expect(controller.signal.aborted).toBe(true);
        });

        it('propagates fetch errors', async () => {
            const error = new TypeError('fetch failed');
            fetchMock.mockRejectedValue(error);

            const controller = new AbortController();

            await expect(
                transport.request({
                    url: 'https://example.com/api',
                    method: HTTP_METHOD_GET,
                    headers: {},
                    requestAbortSignal: controller.signal,
                }),
            ).rejects.toBe(error);
        });
    });
});
