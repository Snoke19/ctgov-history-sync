import { LimiterFactory } from '../limiter/factory/limiterFactory.js';
import type { Limiter } from '../limiter/limiter.js';
import type { HttpTransport } from '../transport/httpTransport.js';
import type { HttpClientOptions } from '../types/http.js';
import { Endpoint } from './endpoint.js';
import { EndpointDefinition, EndpointProvider } from './provider/endpointProvider.js';

export type EndpointCtor = (id: string, limiter: Limiter, transport: HttpTransport) => Endpoint;

const defaultEndpointCtor: EndpointCtor = (id, limiter, transport) => new Endpoint(id, limiter, transport);

/**
 * Constructs a single endpoint from a definition, transferring transport
 * ownership.
 *
 * Ownership invariant: once `createTransport()` has produced a transport,
 * this function is the sole owner until the Endpoint exists. If limiter
 * creation or endpoint construction fails, the transport is closed BEFORE
 * the failure is propagated.
 *
 * If transport cleanup itself fails, both the original construction failure
 * and the cleanup failure are preserved in an AggregateError.
 */
export async function constructEndpoint(
    definition: EndpointDefinition,
    createLimiter: () => Limiter,
    createEndpoint: EndpointCtor = defaultEndpointCtor,
): Promise<Endpoint> {
    const transport = definition.createTransport();

    try {
        return createEndpoint(definition.id, createLimiter(), transport);
    } catch (error) {
        try {
            await transport.close();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `Failed to construct endpoint "${definition.id}" and transport cleanup also failed.`,
                { cause: error },
            );
        }

        throw error;
    }
}

/**
 * Batch endpoint assembly with all-or-nothing rollback.
 *
 * If endpoint N fails to construct, every successfully constructed endpoint
 * before N is closed and the original error is rethrown.
 *
 * Cleanup is awaited for EVERY previously constructed endpoint, even when
 * one or more cleanup operations fail.
 *
 * If cleanup fails, the original construction failure remains the primary
 * error and every cleanup failure is preserved in the resulting AggregateError.
 */
export async function assembleEndpoints(
    definitions: readonly EndpointDefinition[],
    createLimiter: () => Limiter,
    createEndpoint: EndpointCtor = defaultEndpointCtor,
): Promise<Endpoint[]> {
    const endpoints: Endpoint[] = [];

    try {
        for (const definition of definitions) {
            endpoints.push(await constructEndpoint(definition, createLimiter, createEndpoint));
        }

        return endpoints;
    } catch (error) {
        const cleanupResults = await Promise.allSettled(endpoints.map((endpoint) => endpoint.close()));

        const cleanupErrors = cleanupResults
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason);

        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                [error, ...cleanupErrors],
                'Endpoint assembly failed and rollback cleanup also failed.',
                { cause: error },
            );
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

    async build(options: HttpClientOptions): Promise<Endpoint[]> {
        const createLimiter = (): Limiter => this.limiterFactory.create(options);

        return assembleEndpoints(this.provider.build(options), createLimiter);
    }
}
