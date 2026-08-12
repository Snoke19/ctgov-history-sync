import { describe, expect, it, jest } from '@jest/globals';
import { Limiter } from '../../../../src/http/limiter/limiter.js';
import { LimiterFactory } from '../../../../src/http/limiter/factory/limiterFactory.js';
import { Endpoint } from '../../../../src/http/endpoint/endpoint.js';
import { EndpointProvider } from '../../../../src/http/endpoint/provider/endpointProvider.js';
import { HttpClientOptions } from '../../../../src/http/types/http.js';
import { EndpointFactory } from '../../../../src/http/endpoint/endpointFactory.js';

describe('EndpointFactory', () => {
    const createStubs = () => {
        const limiter1 = {} as Limiter;
        const limiter2 = {} as Limiter;

        const limiterFactory = {
            create: jest.fn<LimiterFactory['create']>().mockReturnValueOnce(limiter1).mockReturnValueOnce(limiter2),
        } satisfies LimiterFactory;

        const fakeEndpoints = [{ url: 'http://proxy1' } as Endpoint, { url: 'http://proxy2' } as Endpoint];

        const provider = {
            build: jest.fn<EndpointProvider['build']>().mockReturnValue(fakeEndpoints),
        } satisfies EndpointProvider;

        const options = {
            acquireTimeout: 5000,
            concurrency: 10,
        } as HttpClientOptions;

        return { limiterFactory, provider, options, limiter1, limiter2, fakeEndpoints };
    };

    describe('build', () => {
        it('delegates endpoint construction to the injected provider with options and a createLimiter function', () => {
            const { limiterFactory, provider, options } = createStubs();
            const factory = new EndpointFactory(provider, limiterFactory);

            factory.build(options);

            expect(provider.build).toHaveBeenCalledTimes(1);
            expect(provider.build).toHaveBeenCalledWith(options, expect.any(Function));
        });

        it('returns the endpoints produced by the provider', () => {
            const { limiterFactory, provider, options, fakeEndpoints } = createStubs();
            const factory = new EndpointFactory(provider, limiterFactory);

            const result = factory.build(options);

            expect(result).toBe(fakeEndpoints);
        });

        it('does not eagerly create a limiter during build()', () => {
            const { limiterFactory, provider, options } = createStubs();
            const factory = new EndpointFactory(provider, limiterFactory);

            factory.build(options);

            expect(limiterFactory.create).not.toHaveBeenCalled();
        });

        it('creates a fresh limiter on each createLimiter invocation', () => {
            const { limiterFactory, provider, options, limiter1, limiter2 } = createStubs();
            const factory = new EndpointFactory(provider, limiterFactory);

            factory.build(options);

            const [, createLimiter] = provider.build.mock.calls[0]!;
            const first = createLimiter();
            const second = createLimiter();

            expect(first).toBe(limiter1);
            expect(second).toBe(limiter2);
            expect(limiterFactory.create).toHaveBeenCalledTimes(2);
            expect(limiterFactory.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    acquireTimeout: 5000,
                    concurrency: 10,
                }),
            );
            expect(limiterFactory.create).toHaveBeenNthCalledWith(2, options);
        });

        it('passes through an empty endpoint array without creating limiters', () => {
            const { limiterFactory, provider, options } = createStubs();
            provider.build.mockReturnValue([]);
            const factory = new EndpointFactory(provider, limiterFactory);

            const result = factory.build(options);

            expect(result).toEqual([]);
            expect(limiterFactory.create).not.toHaveBeenCalled();
        });

        it('propagates provider errors without creating limiters eagerly', () => {
            const { limiterFactory, provider, options } = createStubs();
            provider.build.mockImplementation(() => {
                throw new Error('provider boom');
            });
            const factory = new EndpointFactory(provider, limiterFactory);

            expect(() => factory.build(options)).toThrow('provider boom');
            expect(limiterFactory.create).not.toHaveBeenCalled();
        });

        it('propagates limiterFactory errors when createLimiter is invoked', () => {
            const { limiterFactory, provider, options } = createStubs();
            limiterFactory.create.mockReset().mockImplementation(() => {
                throw new Error('limiter boom');
            });
            const factory = new EndpointFactory(provider, limiterFactory);

            factory.build(options);

            const [, createLimiter] = provider.build.mock.calls[0]!;
            expect(() => createLimiter()).toThrow('limiter boom');
        });

        it('does not create limiters when provider ignores createLimiter', () => {
            const { limiterFactory, provider, options } = createStubs();
            provider.build.mockImplementation((_opts, _createLimiter) => []);
            const factory = new EndpointFactory(provider, limiterFactory);

            factory.build(options);

            expect(limiterFactory.create).not.toHaveBeenCalled();
        });
    });
});
