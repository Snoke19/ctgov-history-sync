import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DirectEndpointProvider } from '../../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { DirectTransportFactory } from '../../../../../src/http/transport/factory/directTransportFactory.js';
import { HttpTransport } from '../../../../../src/http/transport/httpTransport.js';

describe('DirectEndpointProvider', () => {
    let transportFactory: { create: jest.Mock<() => HttpTransport> };

    const makeTransport = (): HttpTransport =>
        ({ close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) }) as unknown as HttpTransport;

    beforeEach(() => {
        jest.clearAllMocks();
        transportFactory = {
            create: jest.fn(),
        };
    });

    describe('build', () => {
        it('returns a single definition with id "direct"', () => {
            const provider = new DirectEndpointProvider(transportFactory);

            const definitions = provider.build();

            expect(definitions).toHaveLength(1);
            expect(definitions[0]!.id).toBe('direct');
        });

        it('does not create transports during build() — creation is deferred to createTransport', () => {
            const provider = new DirectEndpointProvider(transportFactory);

            provider.build();

            expect(transportFactory.create).not.toHaveBeenCalled();
        });

        it('createTransport delegates to transportFactory.create with no arguments', () => {
            const transport = makeTransport();
            transportFactory.create.mockReturnValue(transport);

            const provider = new DirectEndpointProvider(transportFactory);
            const [definition] = provider.build();

            expect(definition!.createTransport()).toBe(transport);
            expect(transportFactory.create).toHaveBeenCalledWith();
        });

        it('creates a fresh transport on every createTransport call', () => {
            const t1 = makeTransport();
            const t2 = makeTransport();
            transportFactory.create.mockReturnValueOnce(t1).mockReturnValueOnce(t2);

            const provider = new DirectEndpointProvider(transportFactory);
            const [definition] = provider.build();

            expect(definition!.createTransport()).toBe(t1);
            expect(definition!.createTransport()).toBe(t2);
            expect(transportFactory.create).toHaveBeenCalledTimes(2);
        });

        it('returns a fresh definition instance on every build call', () => {
            const provider = new DirectEndpointProvider(transportFactory);

            const [first] = provider.build();
            const [second] = provider.build();

            expect(first).not.toBe(second);
        });

        it('always returns exactly one definition regardless of how often build is called', () => {
            const provider = new DirectEndpointProvider(transportFactory);

            expect(provider.build()).toHaveLength(1);
            expect(provider.build()).toHaveLength(1);
            expect(provider.build()).toHaveLength(1);
        });
    });

    describe('construction', () => {
        it('does not throw when constructed, even if transportFactory is undefined (defers failure)', () => {
            expect(() => new DirectEndpointProvider(undefined as unknown as DirectTransportFactory)).not.toThrow();
        });

        it('defers a missing transportFactory failure to createTransport time', () => {
            const provider = new DirectEndpointProvider(undefined as unknown as DirectTransportFactory);
            const [definition] = provider.build();

            expect(() => definition!.createTransport()).toThrow();
        });
    });
});
