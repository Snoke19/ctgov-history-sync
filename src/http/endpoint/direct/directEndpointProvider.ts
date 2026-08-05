import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import { Endpoint } from '../endpoint.js';
import type { EndpointProvider } from '../types/endpointProvider.js';
import type { HttpTransport } from '../types/transport.js';
import { logger } from '../../../config/logging.js';

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transport: HttpTransport) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        logger.info(`DirectEndpointProvider options are skipped! '${options}'`);
        return [new Endpoint('direct', createLimiter(), this.transport)];
    }
}
