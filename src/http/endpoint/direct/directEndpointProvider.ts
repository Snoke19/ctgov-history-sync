import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import { Endpoint } from '../endpoint.js';
import { logger } from '../../../config/logging.js';
import { EndpointProvider } from '../endpointFactory.js';
import { DirectTransportFactory } from '../transport/fetchTransport.js';

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: DirectTransportFactory) {}

    build(_options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        logger.debug('DirectEndpointProvider: building single direct endpoint');
        return [new Endpoint('direct', createLimiter(), this.transportFactory.create())];
    }
}
