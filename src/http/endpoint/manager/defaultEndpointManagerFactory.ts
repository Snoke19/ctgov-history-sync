import type { Endpoint } from '../endpoint.js';
import { EndpointManager, EndpointManagerOptions } from './endpointManager.js';
import { EndpointManagerFactory } from './endpointManagerFactory.js';

export class DefaultEndpointManagerFactory implements EndpointManagerFactory {
    constructor(private readonly options: EndpointManagerOptions) {}

    create(endpoints: readonly Endpoint[]): EndpointManager {
        return new EndpointManager(endpoints, this.options);
    }
}
