import { describe, expect, it, jest } from '@jest/globals';
import { defaultHttpClientDefaults, defaultRetryPolicyConfig } from '../../../src/api/api.js';
import { ConfigurationError, EndpointAssemblyError } from '../../../src/error/errors.js';
import { DefaultEndpointManagerFactory } from '../../../src/http/endpoint/manager/defaultEndpointManagerFactory.js';
import { createHttpClient } from '../../../src/http/httpClient.js';
import { DefaultLimiterFactory } from '../../../src/http/limiter/factory/defaultLimiterFactory.js';
import { createProxyOptions } from '../fixtures/clientOptions.fixture.js';
import { DEFAULT_PROXY_URLS } from '../fixtures/constants.js';
import { createEndpointProvider, createProxyEndpointManager } from '../fixtures/endpoint.fixture.js';
import { buildHttpClientOptions } from '../fixtures/httpClient.fixture.js';
import { createMockTransport } from '../fixtures/transport.fixture.js';

describe('Proxy + Undici construction chain', () => {
    it('cleans up created transports when endpoint manager assembly fails', async () => {
        const transport = createMockTransport();
        const provider = createEndpointProvider(transport);

        await expect(
            createHttpClient(
                buildHttpClientOptions(provider, {
                    endpointManagerFactory: new DefaultEndpointManagerFactory({
                        endpointAcquireTimeoutMs: 0,
                    }),
                }),
            ),
        ).rejects.toBeInstanceOf(EndpointAssemblyError);

        expect(transport.close).toHaveBeenCalledTimes(1);
    });

    it('returns EndpointAssemblyError when EndpointManager construction fails and cleanup fails', async () => {
        const cleanupError = new Error('endpoint cleanup failed');

        const transport = createMockTransport(jest.fn<() => Promise<void>>().mockRejectedValue(cleanupError));
        const provider = createEndpointProvider(transport);

        await expect(
            createHttpClient(
                buildHttpClientOptions(provider, {
                    endpointManagerFactory: new DefaultEndpointManagerFactory({
                        endpointAcquireTimeoutMs: 0,
                    }),
                }),
            ),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'EndpointAssemblyError',
                cleanupErrors: [cleanupError],
            }),
        );

        expect(transport.close).toHaveBeenCalledTimes(1);
    });

    it('rejects construction when retryConfig includes 404 in retryableStatusCodes', async () => {
        await expect(
            createHttpClient(
                buildHttpClientOptions(createEndpointProvider(createMockTransport()), {
                    defaults: {
                        ...defaultHttpClientDefaults,
                        retryPolicy: {
                            ...defaultRetryPolicyConfig,
                            retryableStatusCodes: new Set([404]),
                        },
                    },
                }),
            ),
        ).rejects.toThrow('404 must not be in retryableStatusCodes');
    });

    it('rejects construction when retryConfig contains an invalid status code', async () => {
        await expect(
            createHttpClient(
                buildHttpClientOptions(createEndpointProvider(createMockTransport()), {
                    defaults: {
                        ...defaultHttpClientDefaults,
                        retryPolicy: {
                            ...defaultRetryPolicyConfig,
                            retryableStatusCodes: new Set([600]),
                        },
                    },
                }),
            ),
        ).rejects.toThrow('retryableStatusCodes contains invalid status: 600');
    });

    it('rejects construction when retryConfig.baseDelayMs is not a positive integer', async () => {
        await expect(
            createHttpClient(
                buildHttpClientOptions(createEndpointProvider(createMockTransport()), {
                    defaults: {
                        ...defaultHttpClientDefaults,
                        retryPolicy: {
                            retryOnTimeout: true,
                            retryOnNetworkError: true,
                            retryableStatusCodes: new Set([500]),
                            baseDelayMs: 0,
                            backoffCapMs: 1,
                        },
                    },
                }),
            ),
        ).rejects.toThrow('baseDelayMs must be a positive integer');
    });

    it('builds successfully with rate limiting disabled', async () => {
        const manager = await createProxyEndpointManager(createProxyOptions());

        try {
            expect(manager.endpointCount).toBe(2);
        } finally {
            await manager.close();
        }
    });

    it('builds successfully with rate limiting enabled', async () => {
        const manager = await createProxyEndpointManager(
            createProxyOptions(),
            DEFAULT_PROXY_URLS,
            new DefaultLimiterFactory({
                enabled: true,
                capacity: 40,
                windowMs: 60000,
            }),
        );

        try {
            expect(manager.endpointCount).toBe(2);
        } finally {
            await manager.close();
        }
    });

    it('creates exactly one endpoint per valid proxy URL', async () => {
        const manager = await createProxyEndpointManager(
            createProxyOptions(),
            'http://p1:8080,http://p2:8080,http://p3:8080',
        );

        try {
            expect(manager.endpointCount).toBe(3);
        } finally {
            await manager.close();
        }
    });

    it('throws ConfigurationError when proxyUrls is empty', async () => {
        await expect(createProxyEndpointManager(createProxyOptions(), '')).rejects.toBeInstanceOf(ConfigurationError);

        await expect(createProxyEndpointManager(createProxyOptions(), '')).rejects.toThrow('No valid proxy URLs');
    });

    it('throws ConfigurationError when every proxyUrl is invalid', async () => {
        await expect(
            createProxyEndpointManager(createProxyOptions(), 'not-a-url,also-bad://missing-port'),
        ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('throws when endpointAcquireTimeoutMs is missing', async () => {
        const options = createProxyOptions();

        delete (options as unknown as Record<string, unknown>).endpointAcquireTimeoutMs;

        await expect(createProxyEndpointManager(options)).rejects.toBeInstanceOf(EndpointAssemblyError);
    });

    it('throws when concurrency is missing', async () => {
        const options = createProxyOptions();

        delete (options as unknown as Record<string, unknown>).concurrency;

        await expect(createProxyEndpointManager(options)).rejects.toBeInstanceOf(ConfigurationError);
    });

    it('produces a manager whose endpoints can be closed cleanly', async () => {
        const manager = await createProxyEndpointManager(createProxyOptions());

        await expect(manager.close()).resolves.toBeUndefined();
    });
});
