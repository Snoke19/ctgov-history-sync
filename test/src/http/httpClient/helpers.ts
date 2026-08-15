import pino from 'pino';
import { DefaultEndpointManagerFactory } from '../../../../src/http/endpoint/manager/defaultEndpointManagerFactory.js';
import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import type { HttpClientOptions } from '../../../../src/http/http.js';
import { createHttpClient } from '../../../../src/http/httpClient.js';
import type { HttpClient } from '../../../../src/http/httpClient.js';
import { DefaultLimiterFactory } from '../../../../src/http/limiter/factory/defaultLimiterFactory.js';
import type { LimiterFactory } from '../../../../src/http/limiter/factory/limiterFactory.js';
import { FetchDirectTransportFactory } from '../../../../src/http/transport/impl/fetchDirectTransport.js';

export const testLogger = pino({ level: 'silent' });

export const API_URL = 'http://api.test';

export const ENDPOINT_1 = 'http://test-proxy-1:8080';
export const ENDPOINT_2 = 'http://test-proxy-2:8080';

export class FakeMonotonicClock {
    private _now = 0;

    now = () => this._now;

    advance = (ms: number): void => {
        this._now += ms;
    };
}

export class FakeWallClock {
    private _now = 0;

    now = () => this._now;

    advance = (ms: number): void => {
        this._now += ms;
    };
}

export class FakeSleeper {
    constructor(private readonly clock: FakeMonotonicClock) {}

    sleep = async (ms: number, _signal?: AbortSignal): Promise<void> => {
        this.clock.advance(ms);
        await Promise.resolve();
    };
}

export function createFakes() {
    const monotonicClock = new FakeMonotonicClock();
    const wallClock = new FakeWallClock();
    const sleeper = new FakeSleeper(monotonicClock);

    return {
        monotonicClock,
        wallClock,
        sleep: sleeper.sleep.bind(sleeper),
        random: () => 0.5,
    };
}

// Relies on the global `Response`/`fetch` provided by Node 18+ (undici).
// On older runtimes a fetch polyfill exposing `Response` is required.
export function jsonResponse<T>(
    body: T,
    status = 200,
    headers: Record<string, string> = {},
    statusText = 'OK',
): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        statusText,
        headers: {
            'content-type': 'application/json',
            ...headers,
        },
    });
}

export interface TestClientOptions extends HttpClientOptions {
    readonly concurrency: number;
    readonly acquireTimeout: number;
}

export function createDefaultOptions(overrides: Partial<TestClientOptions> = {}): TestClientOptions {
    const monotonicClock = new FakeMonotonicClock();
    const wallClock = new FakeWallClock();
    const sleeper = new FakeSleeper(monotonicClock);

    return {
        concurrency: 5,
        acquireTimeout: 5000,

        sleep: sleeper.sleep.bind(sleeper),
        random: () => 0.5,

        monotonicClock,
        wallClock,

        ...overrides,
    };
}

export function makeClient(
    optionsOverrides: Partial<TestClientOptions> = {},
    limiterFactory: LimiterFactory = new DefaultLimiterFactory({ enabled: false, capacity: 1, windowMs: 1000 }),
): Promise<HttpClient> {
    const options = createDefaultOptions(optionsOverrides);
    const transportFactory = new FetchDirectTransportFactory();
    const provider = new DirectEndpointProvider(transportFactory);

    return createHttpClient({
        clientOptions: options,
        provider,
        limiterFactory,
        logger: testLogger,
        endpointManagerFactory: new DefaultEndpointManagerFactory({
            acquireTimeout: options.acquireTimeout,
            clock: options.monotonicClock?.now,
            sleep: options.sleep,
        }),
    });
}

export async function withClient(
    run: (client: HttpClient) => Promise<void>,
    optionsOverrides: Partial<HttpClientOptions> = {},
): Promise<void> {
    const client = await makeClient(optionsOverrides);

    try {
        await run(client);
    } finally {
        await client.close();
    }
}
