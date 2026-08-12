import { describe, expect, it } from '@jest/globals';
import { EndpointManager } from '../src/http/endpoint/manager/endpointManager.js';
import { Endpoint } from '../src/http/endpoint/endpoint.js';
import { UnlimitedLimiter } from '../src/http/limiter/impl/unlimitedLimiter.js';

// Minimal dummy transport implementing the interface used by Endpoint.close()
const dummyTransport = {
    request: async () => {
        throw new Error('not used');
    },
    close: async () => {},
};

describe('EndpointManager', () => {
    it('acquires an available endpoint immediately', async () => {
        let now = 0;
        const clock = () => now;
        const sleep = async (ms: number) => {
            now += ms;
        };

        const endpoints = [new Endpoint('e1', new UnlimitedLimiter(), dummyTransport)];
        const manager = new EndpointManager(endpoints, 1000, clock, sleep);

        const handle = await manager.acquireEndpoint(500, undefined as any);
        expect(handle.url).toBe('e1');
    });

    it('round-robins endpoints', async () => {
        let now = 0;
        const clock = () => now;
        const sleep = async (ms: number) => {
            now += ms;
        };

        const endpoints = [
            new Endpoint('e1', new UnlimitedLimiter(), dummyTransport),
            new Endpoint('e2', new UnlimitedLimiter(), dummyTransport),
        ];

        const manager = new EndpointManager(endpoints, 1000, clock, sleep);

        const h1 = await manager.acquireEndpoint(500, undefined as any);
        const h2 = await manager.acquireEndpoint(500, undefined as any);
        // nextIndex should rotate so subsequent acquisition returns the other endpoint
        expect([h1.url, h2.url].sort()).toEqual(['e1', 'e2'].sort());
    });
});
