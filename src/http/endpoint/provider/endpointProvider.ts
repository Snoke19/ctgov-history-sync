import { HttpTransport } from '../../transport/httpTransport.js';

export interface EndpointDefinition {
    readonly id: string;

    readonly createTransport: () => HttpTransport;
}

export interface EndpointProvider {
    build(): EndpointDefinition[];
}
