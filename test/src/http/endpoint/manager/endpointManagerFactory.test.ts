import { describe, expect, it, jest } from '@jest/globals';
import { ConfigurationError, EndpointAcquisitionTimeoutError } from '../../../../../src/error/errors.js';
import { Endpoint } from '../../../../../src/http/endpoint/endpoint.js';
import { EndpointFactory } from '../../../../../src/http/endpoint/endpointFactory.js';
import { EndpointManager } from '../../../../../src/http/endpoint/manager/endpointManager.js';
import { EndpointManagerFactory } from '../../../../../src/http/endpoint/manager/endpointManagerFactory.js';
import { HttpRequest, HttpResponse, HttpTransport } from '../../../../../src/http/endpoint/transport/httpTransport.js';
import { Limiter } from '../../../../../src/http/limiter/limiter.js';
import { Clock } from '../../../../../src/http/types/clock.js';
import { HttpClientOptions } from '../../../../../src/http/types/http.js';

function makeAlwaysAvailableLimiter(): Limiter {
    return { tryAcquire: () => true, timeUntilToken: () => 0 };
}

function makeEndpoint(url: string, limiter: Limiter = makeAlwaysAvailableLimiter()): Endpoint {
    const transport: HttpTransport = {
        request: jest.fn<(options: HttpRequest) => Promise<HttpResponse>>(),
        close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };

    return new Endpoint(url, limiter, transport);
}

function baseOptions(): HttpClientOptions {
    return {
        concurrency: 2,
        acquireTimeout: 1000,
        rateLimitCapacity: 10,
        rateLimitWindow: 1000,
        useRateLimit: false,
    };
}

function stubFactory(endpoints: Endpoint[]): EndpointFactory {
    return { build: () => endpoints } as unknown as EndpointFactory;
}

describe('EndpointManagerFactory', () => {
    it('delegates endpoint construction to the injected factory and returns an EndpointManager', () => {
        const endpoints = [makeEndpoint('http://ep-a'), makeEndpoint('http://ep-b')];
        const build = jest.fn<(options: HttpClientOptions) => Endpoint[]>().mockReturnValue(endpoints);
        const factory = { build } as unknown as EndpointFactory;
        const options = baseOptions();

        const manager = new EndpointManagerFactory(factory).create(options);

        expect(build).toHaveBeenCalledTimes(1);
        expect(build).toHaveBeenCalledWith(options);
        expect(manager).toBeInstanceOf(EndpointManager);
        expect(manager.endpointCount).toBe(2);
    });

    it('can acquire an endpoint through the built manager', async () => {
        const endpoints = [makeEndpoint('http://ep-a')];
        const manager = new EndpointManagerFactory(stubFactory(endpoints)).create(baseOptions());

        const handle = await manager.acquireEndpoint(1000, new AbortController().signal);

        expect(handle.url).toBe('http://ep-a');
    });

    it('forwards the injected clock and acquireTimeout to the manager', async () => {
        let now = 0;
        const clock: Clock = { now: () => now };
        const sleep = jest.fn<(ms: number, signal?: AbortSignal) => Promise<void>>().mockImplementation(async () => {
            // Advance past the deadline so the acquisition loop terminates.
            now += 11;
        });

        const neverAvailable: Limiter = {
            tryAcquire: () => false,
            timeUntilToken: () => 10,
        };

        const manager = new EndpointManagerFactory(
            stubFactory([makeEndpoint('http://ep-busy', neverAvailable)]),
        ).create({
            ...baseOptions(),
            acquireTimeout: 1000,
            clock,
            sleep,
        });

        // No explicit timeout is passed: the manager must use the default
        // acquireTimeout (1000ms) supplied to the factory's create().
        const promise = manager.acquireEndpoint(undefined, new AbortController().signal);

        await expect(promise).rejects.toBeInstanceOf(EndpointAcquisitionTimeoutError);
        await expect(promise).rejects.toMatchObject({ timeoutMs: 1000 });

        // Elapsed time was measured on the injected clock and the wait used the
        // injected sleeper, i.e. the factory forwarded both into EndpointManager.
        expect(sleep).toHaveBeenCalled();
    });

    it('throws ConfigurationError when the factory produces no endpoints', () => {
        expect(() => new EndpointManagerFactory(stubFactory([])).create(baseOptions())).toThrow(ConfigurationError);
    });
});
