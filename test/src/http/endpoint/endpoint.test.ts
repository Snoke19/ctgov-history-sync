import { describe, expect, it, jest } from '@jest/globals';
import { Limiter } from '../../../../src/http/limiter/limiter.js';
import { UndiciHttpTransport } from '../../../../src/http/endpoint/transport/impl/undiciProxyTransport.js';
import { HttpTransport } from '../../../../src/http/endpoint/transport/httpTransport.js';
import { Endpoint } from '../../../../src/http/endpoint/endpoint.js';

describe('Endpoint', () => {
    const createStubs = () => {
        const limiter = {
            tryAcquire: jest.fn<Limiter['tryAcquire']>(),
            timeUntilToken: jest.fn<Limiter['timeUntilToken']>(),
        } satisfies Limiter;

        const transport = {
            request: jest.fn<UndiciHttpTransport['request']>(),
            close: jest.fn<HttpTransport['close']>().mockResolvedValue(undefined),
        } satisfies HttpTransport;

        return { limiter, transport };
    };

    describe('getHandle', () => {
        it('returns a frozen handle containing the url and transport', () => {
            const { limiter, transport } = createStubs();
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            const handle = endpoint.getHandle();

            expect(handle.url).toBe('https://example.com');
            expect(handle.transport).toBe(transport);
            expect(Object.isFrozen(handle)).toBe(true);
        });

        it('returns the same handle instance on repeated calls', () => {
            const { limiter, transport } = createStubs();
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            expect(endpoint.getHandle()).toBe(endpoint.getHandle());
        });
    });

    describe('tryAcquire', () => {
        it('delegates to the limiter with the provided timestamp', () => {
            const { limiter, transport } = createStubs();
            limiter.tryAcquire.mockReturnValue(true);
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            const result = endpoint.tryAcquire(1_234_567);

            expect(limiter.tryAcquire).toHaveBeenCalledTimes(1);
            expect(limiter.tryAcquire).toHaveBeenCalledWith(1_234_567);
            expect(result).toBe(true);
        });

        it('returns false when the limiter refuses', () => {
            const { limiter, transport } = createStubs();
            limiter.tryAcquire.mockReturnValue(false);
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            expect(endpoint.tryAcquire(0)).toBe(false);
        });
    });

    describe('timeUntilToken', () => {
        it('delegates to the limiter with the provided timestamp', () => {
            const { limiter, transport } = createStubs();
            limiter.timeUntilToken.mockReturnValue(42);
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            const result = endpoint.timeUntilToken(9_999);

            expect(limiter.timeUntilToken).toHaveBeenCalledTimes(1);
            expect(limiter.timeUntilToken).toHaveBeenCalledWith(9_999);
            expect(result).toBe(42);
        });
    });

    describe('close', () => {
        it('delegates to transport.close() and returns its promise', async () => {
            const { limiter, transport } = createStubs();
            const closePromise = Promise.resolve();
            transport.close.mockReturnValue(closePromise);
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            const result = endpoint.close();

            expect(transport.close).toHaveBeenCalledTimes(1);
            expect(result).toBe(closePromise);
            await expect(result).resolves.toBeUndefined();
        });

        it('caches the close promise (idempotent)', async () => {
            const { limiter, transport } = createStubs();
            const endpoint = new Endpoint('https://example.com', limiter, transport);

            const p1 = endpoint.close();
            const p2 = endpoint.close();

            expect(transport.close).toHaveBeenCalledTimes(1);
            expect(p1).toBe(p2);
            await expect(p1).resolves.toBeUndefined();
        });

        it('does not call transport.close() before the first invocation', () => {
            const { limiter, transport } = createStubs();
            new Endpoint('https://example.com', limiter, transport);

            expect(transport.close).not.toHaveBeenCalled();
        });
    });
});
