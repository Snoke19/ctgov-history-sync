import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import { Endpoint } from '../endpoint.js';
import type { EndpointProvider } from '../types/endpointProvider.js';
import type { HttpTransport } from '../types/transport.js';
<<<<<<< Updated upstream
import { DirectEndpoint } from './directEndpoint.js';
=======
>>>>>>> Stashed changes
import { logger } from '../../../config/logging.js';

export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transport: HttpTransport) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        logger.info(`DirectEndpointProvider options are skipped! '${options}'`);
<<<<<<< Updated upstream
        return [new DirectEndpoint(createLimiter(), this.transport)];
=======
        return [new Endpoint('direct', createLimiter(), this.transport)];
>>>>>>> Stashed changes
    }
}
