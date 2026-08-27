import { createClockFixture } from './clock.fixture.js';
import { TestClientOptions } from './types.js';

export function createDefaultOptions(overrides: Partial<TestClientOptions> = {}): TestClientOptions {
    const clock = createClockFixture();

    return {
        concurrency: 5,
        endpointAcquireTimeoutMs: 5000,
        ...clock,
        ...overrides,
    };
}

export function createProxyOptions(overrides: Partial<TestClientOptions> = {}): TestClientOptions {
    return createDefaultOptions({
        endpointAcquireTimeoutMs: 30000,
        ...overrides,
    });
}
