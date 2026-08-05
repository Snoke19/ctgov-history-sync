import { HttpTransport } from './transport.js';

export interface EndpointHandle {
    readonly url: string;
    readonly transport: HttpTransport;
}

export interface ProxyEndpointHandle extends EndpointHandle {}

export interface DirectEndpointHandle extends EndpointHandle {}

/**
 * The concrete union returned by {@link EndpointManager.acquireEndpoint}.
 * Check `transport` to determine the endpoint type:
 *
 *   if (handle.transport) { // ProxyEndpointHandle }
 *   else                  { // DirectEndpointHandle }
 */
export type AcquiredEndpointHandle = ProxyEndpointHandle | DirectEndpointHandle;
