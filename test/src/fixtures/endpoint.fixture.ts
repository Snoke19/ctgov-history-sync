import { Endpoint } from '../../../src/http/endpoint/endpoint.js';
import { EndpointFactory } from '../../../src/http/endpoint/endpointFactory.js';
import { EndpointManager } from '../../../src/http/endpoint/manager/endpointManager.js';
import { EndpointDefinition, EndpointProvider } from '../../../src/http/endpoint/provider/endpointProvider.js';
import { ProxyEndpointProvider } from '../../../src/http/endpoint/provider/impl/proxyEndpointProvider.js';
import { HttpProxyUrlParser } from '../../../src/http/endpoint/proxy/httpProxyUrlParser.js';
import type { Limiter } from '../../../src/http/limiter/limiter.js';
import { HttpTransport } from '../../../src/http/transport/httpTransport.js';
import { DEFAULT_PROXY_URLS } from './constants.js';
import { createDisabledLimiterFactory, createMockLimiter } from './limiter.fixture.js';
import { createUndiciTransportFactory } from './transport.fixture.js';
import { TestClientOptions } from './types.js';

export function createMockEndpoint(
    transport: HttpTransport,
    limiter: Limiter = createMockLimiter(),
    url = 'https://proxy.example.com',
): Endpoint {
    return new Endpoint(url, limiter, transport);
}

export function createMockEndpointManager(endpoint: Endpoint, acquireTimeout: number): EndpointManager {
    return new EndpointManager([endpoint], {
        acquireTimeout,
    });
}

export async function createProxyEndpointManager(
    options: TestClientOptions,
    proxyUrls = DEFAULT_PROXY_URLS,
    limiterFactory = createDisabledLimiterFactory(),
) {
    const provider = new ProxyEndpointProvider(createUndiciTransportFactory(), new HttpProxyUrlParser(), {
        proxyUrls,
        concurrency: options.concurrency,
    });

    const factory = new EndpointFactory(provider, limiterFactory);
    const endpoints = await factory.build();

    return new EndpointManager(endpoints, {
        acquireTimeout: options.acquireTimeout,
        clock: options.monotonicClock.now,
        sleep: options.sleep,
    });
}

export function createEndpointProvider(transport: HttpTransport): EndpointProvider {
    const definition: EndpointDefinition = {
        id: 'test-endpoint',
        createTransport: () => transport,
    };

    return {
        build: () => [definition],
    };
}
