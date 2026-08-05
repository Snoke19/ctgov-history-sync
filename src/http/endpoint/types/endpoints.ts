import { HttpTransport } from './transport.js';

export interface EndpointHandle {
    readonly url: string;
    readonly transport: HttpTransport;
}

export interface ProxyEndpointHandle extends EndpointHandle {}

export interface DirectEndpointHandle extends EndpointHandle {}

/**
 * The concrete union returned by {@link EndpointManager.acquireEndpoint}.
 * Both proxy and direct handles expose a transport.
 * Use the endpoint URL ('direct' vs proxy URL) to distinguish if needed.
 */
export type AcquiredEndpointHandle = ProxyEndpointHandle | DirectEndpointHandle;
