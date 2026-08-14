import { HttpTransport } from '../../transport/httpTransport.js';
import { HttpClientOptions } from '../../types/http.js';

export interface EndpointDefinition {
    readonly id: string;

    readonly createTransport: () => HttpTransport;
}

export interface EndpointProvider {
    build(options: HttpClientOptions): EndpointDefinition[];
}
