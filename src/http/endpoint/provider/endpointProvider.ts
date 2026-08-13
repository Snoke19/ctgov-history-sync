import { HttpTransport } from '../../transport/httpTransport.js';
import { HttpClientOptions } from '../../types/http.js';

/**
 * Describes one endpoint that a provider wants to exist.
 *
 * Providers prepare definitions; they never create transports or limiters.
 * Resource creation, ownership transfer and rollback are handled by
 * {@link EndpointFactory}, which closes the transport whenever construction
 * of the endpoint fails.
 */
export interface EndpointDefinition {
    /** Stable endpoint identifier, e.g. 'direct' or a proxy URL. */
    readonly id: string;

    /** Creates the transport for this endpoint. Invoked by EndpointFactory. */
    readonly createTransport: () => HttpTransport;
}

/**
 * Endpoint selection strategy.
 *
 * Each implementation decides which endpoints should exist for the given
 * {@link HttpClientOptions} (direct, proxy, ...) and returns their
 * definitions. Providers are deliberately free of resource lifecycle logic:
 * they describe, they do not construct.
 */
export interface EndpointProvider {
    build(options: HttpClientOptions): EndpointDefinition[];
}
