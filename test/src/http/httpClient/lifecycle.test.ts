import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DefaultEndpointManagerFactory } from '../../../../src/http/endpoint/manager/defaultEndpointManagerFactory.js';
import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { createHttpClient } from '../../../../src/http/httpClient.js';
import { DefaultLimiterFactory } from '../../../../src/http/limiter/factory/defaultLimiterFactory.js';
import {
    FetchDirectTransport,
    FetchDirectTransportFactory,
} from '../../../../src/http/transport/impl/fetchDirectTransport.js';
import { API_URL, createDefaultOptions, jsonResponse, makeClient } from './helpers.js';

const defaultLimiterFactory = new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 });
const defaultEndpointManagerFactory = new DefaultEndpointManagerFactory({ acquireTimeout: 5000 });

describe('HttpClient endpoint lifecycle & resource management', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('handles sequential requests through a single direct endpoint', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ ep: 1 }))
            .mockResolvedValueOnce(jsonResponse({ ep: 2 }));

        const client = await makeClient();

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
        const clientOptions = createDefaultOptions();
        const client = await createHttpClient({
            sleep: clientOptions.sleep,
            random: clientOptions.random,
            wallClock: clientOptions.wallClock,
            provider,
            limiterFactory: defaultLimiterFactory,
            endpointManagerFactory: defaultEndpointManagerFactory,
        });

        await client.close();

        expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when client.close() is called twice', async () => {
        const transport = new FetchDirectTransport();
        const closeSpy = jest.spyOn(transport, 'close');

        const transportFactory = new FetchDirectTransportFactory();
        jest.spyOn(transportFactory, 'create').mockReturnValue(transport);

        const provider = new DirectEndpointProvider(transportFactory);
        const clientOptions = createDefaultOptions();
        const client = await createHttpClient({
            sleep: clientOptions.sleep,
            random: clientOptions.random,
            wallClock: clientOptions.wallClock,
            provider,
            limiterFactory: defaultLimiterFactory,
            endpointManagerFactory: defaultEndpointManagerFactory,
        });

        await client.close();
        await client.close();

        // Endpoint.close() memoizes its close promise, so the underlying
        // transport is released exactly once.
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});
