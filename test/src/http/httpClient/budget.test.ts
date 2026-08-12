import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { NetworkException, TimeoutException } from '../../../../src/http/retry/exceptions.js';
import { EndpointManager } from '../../../../src/http/endpoint/manager/endpointManager.js';
import { API_URL, makeClient } from './helpers.js';

describe('HttpClient deadline budget', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('forwards shrinking deadline budget to endpoint acquisition on each retry', async () => {
        const acquireSpy = jest.spyOn(EndpointManager.prototype, 'acquireEndpoint');

        jest.spyOn(globalThis, 'fetch')
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockRejectedValueOnce(new TypeError('fetch failed'));

        const client = makeClient();
        const deadline = Date.now() + 5000;

        await expect(client.fetchJson(`${API_URL}/budget`, { deadline, maxRetries: 2 })).rejects.toBeInstanceOf(
            NetworkException,
        );

        expect(acquireSpy).toHaveBeenCalledTimes(3); // initial + 2 retries

        const firstRemaining = acquireSpy.mock.calls[0]![0] as number;
        const secondRemaining = acquireSpy.mock.calls[1]![0] as number;
        const thirdRemaining = acquireSpy.mock.calls[2]![0] as number;

        // Each retry must see a smaller (or equal) remaining budget, never a fresh window
        expect(secondRemaining).toBeLessThanOrEqual(firstRemaining);
        expect(thirdRemaining).toBeLessThanOrEqual(secondRemaining);

        acquireSpy.mockRestore();
    });

    it('throws TimeoutException when the deadline budget is exhausted between retries', async () => {
        // Time starts with 5s of budget remaining; the expiry on the failed
        // request pushes the clock past the deadline that the retry would need.
        let currentTime = 1_000_000;

        const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
            currentTime = 1_006_001;
            return Promise.reject(new TypeError('fetch failed: ECONNRESET'));
        });

        const client = makeClient();

        jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

        await expect(
            client.fetchJson(`${API_URL}/deadline-exhausted`, {
                deadline: 1_005_000,
                maxRetries: 1,
            }),
        ).rejects.toBeInstanceOf(TimeoutException);

        // The global budget ran out before the retry could start another request.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});