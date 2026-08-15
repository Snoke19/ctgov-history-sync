import { createLogger } from '../../../../config/logging.js';
import { DirectTransportFactory } from '../../../transport/factory/directTransportFactory.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

const logger = createLogger(import.meta.url);

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: DirectTransportFactory) {}

    build(): EndpointDefinition[] {
        logger.debug('Direct endpoint configured');

        return [
            {
                id: 'direct',
                createTransport: () => this.transportFactory.create(),
            },
        ];
    }
}
