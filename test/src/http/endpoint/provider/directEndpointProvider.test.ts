import { describe, expect, it } from '@jest/globals';
import { DirectEndpointProvider } from '../../../../../src/http/endpoint/provider/impl/directEndpointProvider.js';
import { FetchDirectTransport } from '../../../../../src/http/transport/impl/fetchDirectTransport.js';

describe('DirectEndpointProvider', () => {
    describe('build', () => {
        it('returns a single definition with id "direct"', () => {
            const provider = new DirectEndpointProvider();

            const definitions = provider.build();

            expect(definitions).toHaveLength(1);
            expect(definitions[0]!.id).toBe('direct');
        });

        it('createTransport creates a FetchDirectTransport', () => {
            const provider = new DirectEndpointProvider();
            const [definition] = provider.build();

            expect(definition!.createTransport()).toBeInstanceOf(FetchDirectTransport);
        });

        it('creates a fresh transport on every createTransport call', () => {
            const provider = new DirectEndpointProvider();
            const [definition] = provider.build();

            const t1 = definition!.createTransport();
            const t2 = definition!.createTransport();

            expect(t1).toBeInstanceOf(FetchDirectTransport);
            expect(t2).toBeInstanceOf(FetchDirectTransport);
            expect(t1).not.toBe(t2);
        });

        it('returns a fresh definition instance on every build call', () => {
            const provider = new DirectEndpointProvider();

            const [first] = provider.build();
            const [second] = provider.build();

            expect(first).not.toBe(second);
        });

        it('always returns exactly one definition regardless of how often build is called', () => {
            const provider = new DirectEndpointProvider();

            expect(provider.build()).toHaveLength(1);
            expect(provider.build()).toHaveLength(1);
            expect(provider.build()).toHaveLength(1);
        });
    });
});
