import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { defaultFetchOperationDefaults, defaultHttpClientDefaults } from '../../../../src/api/api.js';
import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { createHttpClient } from '../../../../src/http/httpClient.js';
import { FetchDirectTransport } from '../../../../src/http/transport/impl/fetchDirectTransport.js';
import { API_URL } from '../../fixtures/constants.js';
import { withClient } from '../../fixtures/lifecycle.fixture.js';
import { createDisabledLimiterFactory } from '../../fixtures/limiter.fixture.js';
import { jsonResponse } from '../../fixtures/response.fixture.js';

describe('HttpClient endpoint lifecycle & resource management', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('handles sequential requests through a single direct endpoint', async () => {
        const fetchMock = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(jsonResponse({ ep: 1 }))
            .mockResolvedValueOnce(jsonResponse({ ep: 2 }));

        await withClient(async (client) => {
            const first = await client.fetchJson<{ ep: number }>(`${API_URL}/req1`);
            const second = await client.fetchJson<{ ep: number }>(`${API_URL}/req2`);

            expect(first).toEqual({ ep: 1 });
            expect(second).toEqual({ ep: 2 });
        });

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('closes all endpoints cleanly when client.close() is called', async () => {
        const closeSpy = jest.spyOn(FetchDirectTransport.prototype, 'close').mockResolvedValue(undefined);

        const provider = new DirectEndpointProvider();
        const client = await createHttpClient({
            defaults: defaultHttpClientDefaults,
            fetchDefaults: defaultFetchOperationDefaults,
            provider,
            limiterFactory: createDisabledLimiterFactory(),
            endpointManagerOptions: {
                endpointAcquireTimeoutMs: 5000,
            },
        });

        await client.close();

        expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when client.close() is called twice', async () => {
        const closeSpy = jest.spyOn(FetchDirectTransport.prototype, 'close').mockResolvedValue(undefined);

        const provider = new DirectEndpointProvider();
        const client = await createHttpClient({
            defaults: defaultHttpClientDefaults,
            fetchDefaults: defaultFetchOperationDefaults,
            provider,
            limiterFactory: createDisabledLimiterFactory(),
            endpointManagerOptions: {
                endpointAcquireTimeoutMs: 5000,
            },
        });

        await client.close();
        await client.close();

        // Endpoint.close() memoizes its close promise, so the underlying
        // transport is released exactly once.
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});
