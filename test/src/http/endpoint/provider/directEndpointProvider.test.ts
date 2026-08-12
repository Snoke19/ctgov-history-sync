import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DirectEndpointProvider } from '../../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { DirectTransportFactory } from '../../../../../src/http/endpoint/transport/factory/directTransportFactory.js';
import { HttpTransport } from '../../../../../src/http/endpoint/transport/httpTransport.js';
import { Limiter } from '../../../../../src/http/limiter/limiter.js';
import { HttpClientOptions } from '../../../../../src/http/types/http.js';

describe('DirectEndpointProvider', () => {
    let createLimiter: jest.Mock<() => Limiter>;
    let transportFactory: { create: jest.Mock<() => HttpTransport> };

    beforeEach(() => {
        jest.clearAllMocks();
        createLimiter = jest.fn();
        transportFactory = {
            create: jest.fn(),
        };
    });

    describe('construction', () => {
        it('does not throw when constructed, even if transportFactory is undefined (defers failure)', () => {
            // Bug: no runtime validation in constructor; failure happens later at build()
            expect(() => new DirectEndpointProvider(undefined as unknown as DirectTransportFactory)).not.toThrow();
        });

        it('throws at build time when transportFactory was undefined', () => {
            const provider = new DirectEndpointProvider(undefined as unknown as DirectTransportFactory);
            expect(() => provider.build({} as unknown as HttpClientOptions, createLimiter)).toThrow();
        });
    });

    describe('build - call order & arguments', () => {
        it('calls transportFactory.create before createLimiter', () => {
            const callOrder: string[] = [];
            createLimiter.mockImplementation(() => {
                callOrder.push('limiter');
                return {} as Limiter;
            });
            transportFactory.create.mockImplementation(() => {
                callOrder.push('transport');
                return {} as HttpTransport;
            });

            const provider = new DirectEndpointProvider(transportFactory);
            provider.build({} as HttpClientOptions, createLimiter);

            expect(callOrder).toEqual(['transport', 'limiter']);
        });

        it('invokes createLimiter with no arguments', () => {
            createLimiter.mockReturnValue({} as Limiter);
            transportFactory.create.mockReturnValue({} as HttpTransport);

            const provider = new DirectEndpointProvider(transportFactory);
            provider.build({} as HttpClientOptions, createLimiter);

            expect(createLimiter).toHaveBeenCalledWith();
        });

        it('invokes transportFactory.create with no arguments', () => {
            createLimiter.mockReturnValue({} as Limiter);
            transportFactory.create.mockReturnValue({} as HttpTransport);

            const provider = new DirectEndpointProvider(transportFactory);
            provider.build({} as HttpClientOptions, createLimiter);

            expect(transportFactory.create).toHaveBeenCalledWith();
        });
    });

    describe('build - multiple calls & instance freshness', () => {
        it('returns a new endpoint instance on every build call', () => {
            createLimiter.mockReturnValue({} as Limiter);
            transportFactory.create.mockReturnValue({} as HttpTransport);

            const provider = new DirectEndpointProvider(transportFactory);

            const result1 = provider.build({} as HttpClientOptions, createLimiter);
            const result2 = provider.build({} as HttpClientOptions, createLimiter);

            expect(result1[0]).not.toBe(result2[0]);
            expect(createLimiter).toHaveBeenCalledTimes(2);
            expect(transportFactory.create).toHaveBeenCalledTimes(2);
        });

        it('always returns exactly one endpoint regardless of options content', () => {
            createLimiter.mockReturnValue({} as Limiter);
            transportFactory.create.mockReturnValue({} as HttpTransport);

            const provider = new DirectEndpointProvider(transportFactory);

            expect(provider.build({ concurrency: 1 } as unknown as HttpClientOptions, createLimiter)).toHaveLength(1);
            expect(provider.build({ concurrency: 999, timeout: 0 } as unknown as HttpClientOptions, createLimiter)).toHaveLength(1);
            expect(provider.build({} as HttpClientOptions, createLimiter)).toHaveLength(1);
            expect(provider.build(undefined as unknown as HttpClientOptions, createLimiter)).toHaveLength(1);
        });
    });

    describe('build - error handling & resource leaks', () => {
        it('propagates error when createLimiter throws', () => {
            const error = new Error('Limiter creation failed');
            const closeMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
            transportFactory.create.mockImplementation(() => ({ close: closeMock } as unknown as HttpTransport));
            createLimiter.mockImplementation(() => {
                throw error;
            });

            const provider = new DirectEndpointProvider(transportFactory);

            expect(() => provider.build({} as HttpClientOptions, createLimiter)).toThrow(error);
            expect(transportFactory.create).toHaveBeenCalledTimes(1);
            expect(createLimiter).toHaveBeenCalledTimes(1);
            expect(closeMock).toHaveBeenCalledTimes(1);
        });

        it('propagates error when transportFactory.create throws', () => {
            const error = new Error('Transport creation failed');
            transportFactory.create.mockImplementation(() => {
                throw error;
            });

            const provider = new DirectEndpointProvider(transportFactory);

            expect(() => provider.build({} as HttpClientOptions, createLimiter)).toThrow(error);
            expect(transportFactory.create).toHaveBeenCalledTimes(1);
            expect(createLimiter).not.toHaveBeenCalled();
        });

        it('closes the transport when createLimiter throws', () => {
            const error = new Error('Limiter creation failed');
            const closeMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
            const transport = { close: closeMock } as unknown as HttpTransport;
            createLimiter.mockImplementation(() => {
                throw error;
            });
            transportFactory.create.mockImplementation(() => transport);

            const provider = new DirectEndpointProvider(transportFactory);

            expect(() => provider.build({} as HttpClientOptions, createLimiter)).toThrow(error);
            expect(transportFactory.create).toHaveBeenCalledTimes(1);
            expect(closeMock).toHaveBeenCalledTimes(1);
        });

        it('closes transport and throws when createLimiter parameter is undefined', () => {
            const closeMock = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
            transportFactory.create.mockImplementation(() => ({ close: closeMock } as unknown as HttpTransport));
            const provider = new DirectEndpointProvider(transportFactory);

            expect(() => provider.build({} as unknown as HttpClientOptions, undefined as unknown as () => Limiter)).toThrow();
            expect(transportFactory.create).toHaveBeenCalledTimes(1);
            expect(closeMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('build - input safety', () => {
        it('does not mutate the provided HttpClientOptions object', () => {
            const options = { foo: 'bar', nested: { value: 42 } } as unknown as HttpClientOptions;
            createLimiter.mockReturnValue({} as Limiter);
            transportFactory.create.mockReturnValue({} as HttpTransport);

            const provider = new DirectEndpointProvider(transportFactory);
            provider.build(options, createLimiter);

            expect(options).toEqual({ foo: 'bar', nested: { value: 42 } });
        });

        it('works when createLimiter returns the same limiter instance on repeated calls', () => {
            const sharedLimiter = {} as Limiter;
            createLimiter.mockReturnValue(sharedLimiter);
            transportFactory.create.mockReturnValue({} as HttpTransport);

            const provider = new DirectEndpointProvider(transportFactory);

            const result1 = provider.build({} as HttpClientOptions, createLimiter);
            const result2 = provider.build({} as HttpClientOptions, createLimiter);

            expect(result1[0]).not.toBe(result2[0]);
        });

        it('works when transportFactory returns the same transport instance on repeated calls', () => {
            const sharedTransport = {} as HttpTransport;
            createLimiter.mockReturnValue({} as Limiter);
            transportFactory.create.mockReturnValue(sharedTransport);

            const provider = new DirectEndpointProvider(transportFactory);

            const result1 = provider.build({} as HttpClientOptions, createLimiter);
            const result2 = provider.build({} as HttpClientOptions, createLimiter);

            expect(result1[0]).not.toBe(result2[0]);
        });
    });
});
