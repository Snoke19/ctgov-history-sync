import {beforeEach, describe, expect, jest, test} from '@jest/globals';

const ProxyAgentMock = jest.fn(function ProxyAgent(opts) {
    this.opts = opts;
});

jest.unstable_mockModule('undici', () => ({
    ProxyAgent: ProxyAgentMock,
}));

const poolFactoryMock = jest.fn();

jest.unstable_mockModule('../../../src/http/poolFactory.js', () => ({
    poolFactory: poolFactoryMock,
}));

const {ProxyEndpoint} = await import('../../../src/http/endpoint/proxyEndpoint.js');
const {Endpoint} = await import('../../../src/http/endpoint/endpoint.js');

beforeEach(() => {
    ProxyAgentMock.mockClear();
});

describe('ProxyEndpoint', () => {
    test('extends Endpoint', () => {
        expect(new ProxyEndpoint('http://u:p@1.2.3.4:80')).toBeInstanceOf(Endpoint);
    });

    test('constructs a ProxyAgent with uri set to the proxy url', () => {
        new ProxyEndpoint('http://u:p@1.2.3.4:80');

        expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
        expect(ProxyAgentMock).toHaveBeenCalledWith(
            expect.objectContaining({uri: 'http://u:p@1.2.3.4:80'}),
        );
    });

    test('wires poolFactory as the ProxyAgent clientFactory', () => {
        new ProxyEndpoint('http://u:p@1.2.3.4:80');

        expect(ProxyAgentMock).toHaveBeenCalledWith(
            expect.objectContaining({clientFactory: poolFactoryMock}),
        );
    });

    test('getHandle() returns url and a dispatcher backed by the ProxyAgent', () => {
        const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
        const handle = endpoint.getHandle();

        expect(handle.url).toBe('http://u:p@1.2.3.4:80');
        expect(handle.dispatcher).toBeInstanceOf(ProxyAgentMock);
    });

    test('getHandle() returns a frozen object', () => {
        const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
        expect(Object.isFrozen(endpoint.getHandle())).toBe(true);
    });

    test('getHandle() always returns the same handle instance (dispatcher not recreated)', () => {
        const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
        expect(endpoint.getHandle()).toBe(endpoint.getHandle());
        expect(ProxyAgentMock).toHaveBeenCalledTimes(1);
    });

    test('each ProxyEndpoint instance gets its own ProxyAgent', () => {
        const a = new ProxyEndpoint('http://u:p@1.2.3.4:80');
        const b = new ProxyEndpoint('http://u:p@5.6.7.8:81');

        expect(a.getHandle().dispatcher).not.toBe(b.getHandle().dispatcher);
        expect(ProxyAgentMock).toHaveBeenCalledTimes(2);
    });

    test('tryAcquire()/timeUntilToken() delegate to the given limiter', () => {
        const limiter = {
            tryAcquire: jest.fn(() => false),
            timeUntilToken: jest.fn(() => 99)
        };
        const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80', limiter);

        expect(endpoint.tryAcquire()).toBe(false);
        expect(endpoint.timeUntilToken()).toBe(99);
    });

    test('tryAcquire() returns true unconditionally with no limiter', () => {
        const endpoint = new ProxyEndpoint('http://u:p@1.2.3.4:80');
        expect(endpoint.tryAcquire()).toBe(true);
    });
});