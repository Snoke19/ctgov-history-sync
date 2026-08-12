import { LimiterFactory } from '../limiter/factory/limiterFactory.js';
import type { Limiter } from '../limiter/limiter.js';
import type { HttpClientOptions } from '../types/http.js';
import { Endpoint } from './endpoint.js';
import { EndpointDefinition, EndpointProvider } from './provider/endpointProvider.js';
import type { HttpTransport } from './transport/httpTransport.js';

export type EndpointCtor = (id: string, limiter: Limiter, transport: HttpTransport) => Endpoint;

const defaultEndpointCtor: EndpointCtor = (id, limiter, transport) => new Endpoint(id, limiter, transport);

/**
 * Constructs a single endpoint from a definition, transferring transport
 * ownership.
 *
 * Ownership invariant: once `createTransport()` has produced a transport,
 * this function is the sole owner until the Endpoint exists. If limiter
 * creation or endpoint construction fails, the transport is closed before
 * the error is rethrown.
 */
export function constructEndpoint(
    definition: EndpointDefinition,
    createLimiter: () => Limiter,
    createEndpoint: EndpointCtor = defaultEndpointCtor,
): Endpoint {
    const transport = definition.createTransport();
    try {
        return createEndpoint(definition.id, createLimiter(), transport);
    } catch (error) {
        void transport.close();
        throw error;
    }
}

/**
 * Batch endpoint assembly with all-or-nothing rollback.
 *
 * If endpoint N fails to construct, every successfully constructed endpoint
 * before N is closed and the original error is rethrown.
 */
export function assembleEndpoints(
    definitions: readonly EndpointDefinition[],
    createLimiter: () => Limiter,
    createEndpoint: EndpointCtor = defaultEndpointCtor,
): Endpoint[] {
    const endpoints: Endpoint[] = [];
    try {
        for (const definition of definitions) {
            endpoints.push(constructEndpoint(definition, createLimiter, createEndpoint));
        }
        return endpoints;
    } catch (error) {
        for (const endpoint of endpoints) {
            void endpoint.close();
        }
        throw error;
    }
}

/**
 * Builds the concrete {@link Endpoint} list from {@link HttpClientOptions}.
 *
 * Responsibilities:
 *   - Ask the injected {@link EndpointProvider} which endpoints should exist.
 *   - Create transports and limiters, transfer ownership to {@link Endpoint},
 *     and roll back every created resource when construction fails.
 *
 * Rate-limit validation lives inside the injected {@link LimiterFactory}.
 */
export class EndpointFactory {
    constructor(
        private readonly provider: EndpointProvider,
        private readonly limiterFactory: LimiterFactory,
    ) {}

    build(options: HttpClientOptions): Endpoint[] {
        const createLimiter = (): Limiter => this.limiterFactory.create(options);
        return assembleEndpoints(this.provider.build(options), createLimiter);
    }
}
