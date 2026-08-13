import { logger } from '../../../../config/logging.js';
import { DirectTransportFactory } from '../../../transport/factory/directTransportFactory.js';
import { HttpClientOptions } from '../../../types/http.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: DirectTransportFactory) {}

    build(_options: HttpClientOptions): EndpointDefinition[] {
        logger.debug('DirectEndpointProvider: building single direct endpoint');

        return [
            {
                id: 'direct',
                createTransport: () => this.transportFactory.create(),
            },
        ];
    }
}
