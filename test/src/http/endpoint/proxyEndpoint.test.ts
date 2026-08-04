import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Dispatcher } from 'undici';
import { ProxyEndpoint } from '../../../../src/http/endpoint/proxy/proxyEndpoint.js';
import type { Limiter } from '../../../../src/http/limiter/limiter.js';

void jest;

const createMockLimiter = (): Limiter => ({} as Limiter);

const createMockDispatcher = (): Dispatcher => ({
    request: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined as never),
} as unknown as Dispatcher);

describe('ProxyEndpoint', () => {
    const proxyUrl = 'http://proxy.example.com:8080';
    let limiter: Limiter;
    let dispatcher: Dispatcher;

    beforeEach(() => {
        limiter = createMockLimiter();
        dispatcher = createMockDispatcher();
    });

    describe('constructor', () => {
        it('creates an instance with valid arguments', () => {
            const endpoint = new ProxyEndpoint(proxyUrl, limiter, dispatcher);
            expect(endpoint).toBeInstanceOf(ProxyEndpoint);
            expect(endpoint.getHandle().url).toBe(proxyUrl);
            expect(endpoint.getHandle().dispatcher).toBe(dispatcher);
        });

        it('throws if dispatcher is missing', () => {
            expect(() => {
                new ProxyEndpoint(proxyUrl, limiter, null as any);
            }).toThrow('ProxyEndpoint requires a dispatcher');
        });

        it('throws if dispatcher does not have a request method', () => {
            const badDispatcher = { close: jest.fn() } as any;
            expect(() => {
                new ProxyEndpoint(proxyUrl, limiter, badDispatcher);
            }).toThrow('Provided dispatcher does not implement the required Dispatcher contract');
        });

        it('throws if dispatcher does not have a close method', () => {
            const badDispatcher = { request: jest.fn() } as any;
            expect(() => {
                new ProxyEndpoint(proxyUrl, limiter, badDispatcher);
            }).toThrow('Provided dispatcher does not implement the required Dispatcher contract');
        });

        it('freezes the returned handle object', () => {
            const endpoint = new ProxyEndpoint(proxyUrl, limiter, dispatcher);
            const handle = endpoint.getHandle();
            expect(Object.isFrozen(handle)).toBe(true);
        });
    });

    describe('getHandle', () => {
        it('returns the frozen handle containing the URL and dispatcher', () => {
            const endpoint = new ProxyEndpoint(proxyUrl, limiter, dispatcher);
            const handle = endpoint.getHandle();
            expect(handle).toEqual({
                url: proxyUrl,
                dispatcher,
            });
            expect(endpoint.getHandle()).toBe(handle);
        });
    });

    describe('close', () => {
        it('calls dispatcher.close() once and returns a Promise', async () => {
            const endpoint = new ProxyEndpoint(proxyUrl, limiter, dispatcher);
            const promise = endpoint.close();

            expect(dispatcher.close).toHaveBeenCalledTimes(1);
            expect(promise).toBeInstanceOf(Promise);
            await expect(promise).resolves.toBeUndefined();
        });

        it('caches the close Promise so dispatcher.close() is called only once', async () => {
            const endpoint = new ProxyEndpoint(proxyUrl, limiter, dispatcher);

            const promise1 = endpoint.close();
            const promise2 = endpoint.close();

            expect(dispatcher.close).toHaveBeenCalledTimes(1);
            expect(promise1).toBe(promise2);

            await promise1;
            const promise3 = endpoint.close();
            expect(dispatcher.close).toHaveBeenCalledTimes(1);
            expect(promise3).toBe(promise1);
        });
    });
});