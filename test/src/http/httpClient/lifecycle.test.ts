import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { createHttpClient } from '../../../../src/http/httpClient.js';
import { FetchDirectTransport } from '../../../../src/http/transport/impl/fetchDirectTransport.js';
import { FetchDirectTransportFactory } from '../../../../src/http/transport/impl/fetchDirectTransportFactory.js';
import { API_URL, ENDPOINT_1, ENDPOINT_2, createDefaultOptions, jsonResponse, makeClient } from './helpers.js';

describe('HttpClient endpoint lifecycle & resource management', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('handles sequential requests through a single direct endpoint', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ ep: 1 }))
            .mockResolvedValueOnce(jsonResponse({ ep: 2 }));

        const client = await makeClient({
            proxyUrls: `${ENDPOINT_1},${ENDPOINT_2}`,
        });

        const first = await client.fetchJson<{ ep: number }>(`${API_URL}/req1`);
        const second = await client.fetchJson<{ ep: number }>(`${API_URL}/req2`);

        expect(first).toEqual({ ep: 1 });
        expect(second).toEqual({ ep: 2 });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('closes all endpoints cleanly when client.close() is called', async () => {
        const transport = new FetchDirectTransport();
        const closeSpy = jest.spyOn(transport, 'close');

        const transportFactory = new FetchDirectTransportFactory();
        jest.spyOn(transportFactory, 'create').mockReturnValue(transport);

        const provider = new DirectEndpointProvider(transportFactory);
        const client = await createHttpClient(createDefaultOptions(), provider);

        await client.close();

        expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when client.close() is called twice', async () => {
        const transport = new FetchDirectTransport();
        const closeSpy = jest.spyOn(transport, 'close');

        const transportFactory = new FetchDirectTransportFactory();
        jest.spyOn(transportFactory, 'create').mockReturnValue(transport);

        const provider = new DirectEndpointProvider(transportFactory);
        const client = await createHttpClient(createDefaultOptions(), provider);

        await client.close();
        await client.close();

        // Endpoint.close() memoizes its close promise, so the underlying
        // transport is released exactly once.
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});
