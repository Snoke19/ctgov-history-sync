import { DirectEndpointProvider } from '../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { FetchDirectTransportFactory } from '../../../../src/http/endpoint/transport/factory/fetchDirectTransportFactory.js';
import { createHttpClient } from '../../../../src/http/httpClient.js';
import type { HttpClient } from '../../../../src/http/httpClient.js';
import type { HttpClientOptions } from '../../../../src/http/types/http.js';

export const API_URL = 'http://api.test';

export const ENDPOINT_1 = 'http://test-proxy-1:8080';
export const ENDPOINT_2 = 'http://test-proxy-2:8080';

export class FakeClock {
    private _now = 0;
    now = () => this._now;
    advance = (ms: number) => {
        this._now += ms;
    };
}

export class FakeSleeper {
    constructor(private clock: FakeClock) {}
    sleep = async (ms: number) => {
        this.clock.advance(ms);
        await Promise.resolve();
    };
}

export function createFakes() {
    const clock = new FakeClock();
    const sleeper = new FakeSleeper(clock);
    return {
        clock,
        sleep: sleeper.sleep.bind(sleeper),
        random: () => 0.5,
    };
}

// Relies on the global `Response`/`fetch` provided by Node 18+ (undici).
// On older runtimes a fetch polyfill exposing `Response` is required.
export function jsonResponse<T>(body: T, status = 200, headers: Record<string, string> = {}, statusText = 'OK'): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        statusText,
        headers: {
            'content-type': 'application/json',
            ...headers,
        },
    });
}

export function createDefaultOptions(overrides: Partial<HttpClientOptions> = {}): HttpClientOptions {
    const fakes = createFakes();
    return {
        concurrency: 5,
        acquireTimeout: 5000,
        rateLimitCapacity: 10,
        rateLimitWindow: 1000,
        useRateLimit: false,
        proxyUrls: 'http://test-proxy-0:8080',
        sleep: fakes.sleep,
        random: fakes.random,
        clock: fakes.clock,
        ...overrides,
    };
}

export function makeClient(optionsOverrides: Partial<HttpClientOptions> = {}): HttpClient {
    const transportFactory = new FetchDirectTransportFactory();
    const provider = new DirectEndpointProvider(transportFactory);
    return createHttpClient(createDefaultOptions(optionsOverrides), provider);
}