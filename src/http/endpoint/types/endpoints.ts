import type {ProxyAgent} from 'undici';

export interface EndpointHandle {
    readonly url: string;
}

export interface ProxyEndpointHandle extends EndpointHandle {
    readonly dispatcher: ProxyAgent;
}

export interface DirectEndpointHandle extends EndpointHandle {
    readonly dispatcher: null;
}