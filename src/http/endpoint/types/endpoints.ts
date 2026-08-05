import type { Dispatcher } from 'undici';

export interface EndpointHandle {
    readonly url: string;
}

export interface ProxyEndpointHandle extends EndpointHandle {
    readonly dispatcher: Dispatcher;
}

export interface DirectEndpointHandle extends EndpointHandle {
    readonly dispatcher: null;
}

/**
 * The concrete union returned by {@link EndpointManager.acquireEndpoint}.
 * Callers can narrow on `dispatcher` to distinguish proxy from direct handles:
 *
 *   if (handle.dispatcher) { // ProxyEndpointHandle }
 *   else                    { // DirectEndpointHandle }
 */
export type AcquiredEndpointHandle = ProxyEndpointHandle | DirectEndpointHandle;
