import { describe, expect, it, jest } from '@jest/globals';
import { Endpoint } from '../../../../src/http/endpoint/endpoint.js';
import {
    assembleEndpoints,
    constructEndpoint,
    EndpointCtor,
    EndpointFactory,
} from '../../../../src/http/endpoint/endpointFactory.js';
import { EndpointDefinition, EndpointProvider } from '../../../../src/http/endpoint/provider/endpointProvider.js';
import { HttpTransport } from '../../../../src/http/endpoint/transport/httpTransport.js';
import { LimiterFactory } from '../../../../src/http/limiter/factory/limiterFactory.js';
import { Limiter } from '../../../../src/http/limiter/limiter.js';
import { HttpClientOptions } from '../../../../src/http/types/http.js';

const makeTransport = (): HttpTransport & { close: jest.Mock<() => Promise<void>> } =>
    ({ close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) }) as unknown as HttpTransport & {
        close: jest.Mock<() => Promise<void>>;
    };

const makeLimiter = (): Limiter => ({ tryAcquire: () => true, timeUntilToken: () => 0 });

const makeDefinition = (id: string, transport: HttpTransport): EndpointDefinition => ({
    id,
    createTransport: () => transport,
});

const makeOptions = (): HttpClientOptions =>
    ({
        acquireTimeout: 5000,
        concurrency: 10,
    }) as HttpClientOptions;

describe('constructEndpoint', () => {
    it('transfers transport and limiter ownership into the Endpoint', () => {
        const transport = makeTransport();
        const limiter = makeLimiter();

        const endpoint = constructEndpoint(makeDefinition('direct', transport), () => limiter);

        expect(endpoint).toBeInstanceOf(Endpoint);
        expect(endpoint.url).toBe('direct');
        expect(endpoint.getHandle().transport).toBe(transport);
        expect(endpoint.tryAcquire(0)).toBe(true);
        expect(transport.close).not.toHaveBeenCalled();
    });

    it('closes the transport exactly once and rethrows when limiter creation fails', () => {
        const transport = makeTransport();
        const boom = new Error('limiter boom');

        expect(() =>
            constructEndpoint(makeDefinition('p1', transport), () => {
                throw boom;
            }),
        ).toThrow(boom);

        expect(transport.close).toHaveBeenCalledTimes(1);
    });

    it('closes the transport exactly once and rethrows when Endpoint construction fails', () => {
        const transport = makeTransport();
        const boom = new Error('endpoint boom');

        expect(() =>
            constructEndpoint(makeDefinition('p1', transport), makeLimiter, () => {
                throw boom;
            }),
        ).toThrow(boom);

        expect(transport.close).toHaveBeenCalledTimes(1);
    });
});

describe('assembleEndpoints', () => {
    it('builds all endpoints and leaves their transports open on success', () => {
        const t1 = makeTransport();
        const t2 = makeTransport();

        const result = assembleEndpoints(
            [makeDefinition('a', t1), makeDefinition('b', t2)],
            makeLimiter,
        );

        expect(result.map((e) => e.url)).toEqual(['a', 'b']);
        expect(result[0]!.getHandle().transport).toBe(t1);
        expect(result[1]!.getHandle().transport).toBe(t2);
        expect(t1.close).not.toHaveBeenCalled();
        expect(t2.close).not.toHaveBeenCalled();
    });

    it('creates exactly one limiter per definition', () => {
        const createLimiter = jest.fn(makeLimiter);

        assembleEndpoints(
            [makeDefinition('a', makeTransport()), makeDefinition('b', makeTransport()), makeDefinition('c', makeTransport())],
            createLimiter,
        );

        expect(createLimiter).toHaveBeenCalledTimes(3);
    });

    it('closes every previously created endpoint and the in-flight transport when limiter creation fails mid-batch', () => {
        const t1 = makeTransport();
        const t2 = makeTransport();
        const t3 = makeTransport();
        const boom = new Error('limiter boom on the 3rd endpoint');
        let limiterCalls = 0;

        expect(() =>
            assembleEndpoints(
                [makeDefinition('a', t1), makeDefinition('b', t2), makeDefinition('c', t3)],
                () => {
                    if (++limiterCalls === 3) {
                        throw boom;
                    }
                    return makeLimiter();
                },
            ),
        ).toThrow(boom);

        expect(t1.close).toHaveBeenCalledTimes(1);
        expect(t2.close).toHaveBeenCalledTimes(1);
        expect(t3.close).toHaveBeenCalledTimes(1);
    });

    it('closes earlier endpoints and the in-flight transport when Endpoint construction fails mid-batch', () => {
        const t1 = makeTransport();
        const t2 = makeTransport();
        const boom = new Error('endpoint boom on the 2nd endpoint');
        let endpointCalls = 0;

        const createEndpoint: EndpointCtor = (id, limiter, transport) => {
            if (++endpointCalls === 2) {
                throw boom;
            }
            return new Endpoint(id, limiter, transport);
        };

        expect(() => assembleEndpoints([makeDefinition('a', t1), makeDefinition('b', t2)], makeLimiter, createEndpoint)).toThrow(
            boom,
        );

        expect(t1.close).toHaveBeenCalledTimes(1);
        expect(t2.close).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list for an empty definition list', () => {
        const createLimiter = jest.fn(makeLimiter);

        expect(assembleEndpoints([], createLimiter)).toEqual([]);
        expect(createLimiter).not.toHaveBeenCalled();
    });
});

describe('EndpointFactory', () => {
    it('asks the provider which endpoints should exist', () => {
        const provider = {
            build: jest.fn<EndpointProvider['build']>().mockReturnValue([]),
        } satisfies EndpointProvider;
        const limiterFactory = { create: jest.fn<LimiterFactory['create']>() } satisfies LimiterFactory;
        const factory = new EndpointFactory(provider, limiterFactory);

        factory.build(makeOptions());

        expect(provider.build).toHaveBeenCalledTimes(1);
        expect(provider.build).toHaveBeenCalledWith(makeOptions());
    });

    it('constructs one Endpoint per definition with its own transport and limiter', () => {
        const t1 = makeTransport();
        const t2 = makeTransport();
        const l1 = makeLimiter();
        const l2 = makeLimiter();

        const provider = {
            build: jest
                .fn<EndpointProvider['build']>()
                .mockReturnValue([makeDefinition('p1', t1), makeDefinition('p2', t2)]),
        } satisfies EndpointProvider;
        const limiterFactory = {
            create: jest.fn<LimiterFactory['create']>().mockReturnValueOnce(l1).mockReturnValueOnce(l2),
        } satisfies LimiterFactory;
        const factory = new EndpointFactory(provider, limiterFactory);

        const endpoints = factory.build(makeOptions());

        expect(endpoints).toHaveLength(2);
        expect(endpoints[0]!.url).toBe('p1');
        expect(endpoints[1]!.url).toBe('p2');
        expect(endpoints[0]!.getHandle().transport).toBe(t1);
        expect(endpoints[1]!.getHandle().transport).toBe(t2);
        expect(limiterFactory.create).toHaveBeenCalledTimes(2);
        expect(t1.close).not.toHaveBeenCalled();
        expect(t2.close).not.toHaveBeenCalled();
    });

    it('rolls back every constructed endpoint when a limiter fails mid-batch', () => {
        const t1 = makeTransport();
        const t2 = makeTransport();
        const boom = new Error('limiter boom');

        const provider = {
            build: jest
                .fn<EndpointProvider['build']>()
                .mockReturnValue([makeDefinition('p1', t1), makeDefinition('p2', t2)]),
        } satisfies EndpointProvider;
        const limiterFactory = {
            create: jest
                .fn<LimiterFactory['create']>()
                .mockReturnValueOnce(makeLimiter())
                .mockImplementationOnce(() => {
                    throw boom;
                }),
        } satisfies LimiterFactory;
        const factory = new EndpointFactory(provider, limiterFactory);

        expect(() => factory.build(makeOptions())).toThrow(boom);

        expect(t1.close).toHaveBeenCalledTimes(1);
        expect(t2.close).toHaveBeenCalledTimes(1);
    });

    it('rolls back the in-flight transport when the provider-prepared limiter is not needed', () => {
        // A definition whose transport is created but whose limiter creation
        // fails is closed by the assembly layer even though no Endpoint exists.
        const t1 = makeTransport();
        const boom = new Error('limiter boom');

        const provider = {
            build: jest.fn<EndpointProvider['build']>().mockReturnValue([makeDefinition('p1', t1)]),
        } satisfies EndpointProvider;
        const limiterFactory = {
            create: jest.fn<LimiterFactory['create']>().mockImplementation(() => {
                throw boom;
            }),
        } satisfies LimiterFactory;
        const factory = new EndpointFactory(provider, limiterFactory);

        expect(() => factory.build(makeOptions())).toThrow(boom);
        expect(t1.close).toHaveBeenCalledTimes(1);
    });

    it('passes through an empty definition list without creating limiters or transports', () => {
        const provider = {
            build: jest.fn<EndpointProvider['build']>().mockReturnValue([]),
        } satisfies EndpointProvider;
        const limiterFactory = { create: jest.fn<LimiterFactory['create']>() } satisfies LimiterFactory;
        const factory = new EndpointFactory(provider, limiterFactory);

        expect(factory.build(makeOptions())).toEqual([]);
        expect(limiterFactory.create).not.toHaveBeenCalled();
    });

    it('propagates provider errors without creating transports or limiters', () => {
        const boom = new Error('provider boom');
        const provider = {
            build: jest.fn<EndpointProvider['build']>().mockImplementation(() => {
                throw boom;
            }),
        } satisfies EndpointProvider;
        const limiterFactory = { create: jest.fn<LimiterFactory['create']>() } satisfies LimiterFactory;
        const factory = new EndpointFactory(provider, limiterFactory);

        expect(() => factory.build(makeOptions())).toThrow(boom);
        expect(limiterFactory.create).not.toHaveBeenCalled();
    });
});