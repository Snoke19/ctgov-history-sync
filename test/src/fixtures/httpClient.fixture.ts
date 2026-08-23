import { defaultFetchOperationDefaults, defaultHttpClientDefaults } from '../../../src/api/api.js';
import { DefaultEndpointManagerFactory } from '../../../src/http/endpoint/manager/defaultEndpointManagerFactory.js';
import { EndpointProvider } from '../../../src/http/endpoint/provider/endpointProvider.js';
import { DirectEndpointProvider } from '../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { createHttpClient, HttpClient } from '../../../src/http/httpClient.js';
import { LimiterFactory } from '../../../src/http/limiter/factory/limiterFactory.js';
import { FetchDirectTransportFactory } from '../../../src/http/transport/impl/fetchDirectTransport.js';
import { createDefaultOptions } from './clientOptions.fixture.js';
import { createClockFixture, type ClockFixture } from './clock.fixture.js';
import { createDisabledLimiterFactory } from './limiter.fixture.js';
import { TestClientOptions } from './types.js';

export interface HttpClientFixtureOptions {
    clock?: ClockFixture;
    limiterFactory?: LimiterFactory;
}

export class HttpClientFixture {
    static async direct(options: HttpClientFixtureOptions = {}): Promise<HttpClient> {
        return createTestClient(options.clock, options.limiterFactory ?? createDisabledLimiterFactory());
    }
}

export function createTestClient(
    optionsOverrides: Partial<TestClientOptions> = {},
    limiterFactory: LimiterFactory = createDisabledLimiterFactory(),
): Promise<HttpClient> {
    const options = createDefaultOptions(optionsOverrides);

    return createHttpClient({
        defaults: defaultHttpClientDefaults,
        fetchDefaults: defaultFetchOperationDefaults,
        sleep: options.sleep,
        random: options.random,
        wallClock: options.wallClock,
        provider: new DirectEndpointProvider(new FetchDirectTransportFactory()),
        limiterFactory,
        endpointManagerFactory: new DefaultEndpointManagerFactory({
            acquireTimeout: options.acquireTimeout,
            clock: options.monotonicClock.now,
            sleep: options.sleep,
        }),
    });
}

export function buildHttpClientOptions(
    provider: EndpointProvider,
    overrides: Partial<Parameters<typeof createHttpClient>[0]> = {},
): Parameters<typeof createHttpClient>[0] {
    const clock = createClockFixture();

    return {
        defaults: defaultHttpClientDefaults,
        fetchDefaults: defaultFetchOperationDefaults,
        sleep: clock.sleep,
        random: clock.random,
        wallClock: clock.wallClock,
        provider,
        limiterFactory: createDisabledLimiterFactory(),
        endpointManagerFactory: new DefaultEndpointManagerFactory({
            acquireTimeout: 30000,
            clock: clock.monotonicClock.now,
            sleep: clock.sleep,
        }),
        ...overrides,
    };
}
