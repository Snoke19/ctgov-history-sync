import { DirectTransportFactory } from '../../../transport/factory/directTransportFactory.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: DirectTransportFactory) {}

    build(): EndpointDefinition[] {
        return [
            {
                id: 'direct',
                createTransport: () => this.transportFactory.create(),
            },
        ];
    }
}
