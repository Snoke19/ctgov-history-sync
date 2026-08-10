import { logger } from '../../../../config/logging.js';
import { Limiter } from '../../../limiter/limiter.js';
import { HttpClientOptions } from '../../../types/http.js';
import { Endpoint } from '../../endpoint.js';
import { DirectTransportFactory } from '../../transport/factory/directTransportFactory.js';
import { EndpointProvider } from '../endpointProvider.js';

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: DirectTransportFactory) {}

    build(_options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        logger.debug('DirectEndpointProvider: building single direct endpoint');
        return [new Endpoint('direct', createLimiter(), this.transportFactory.create())];
    }
}
