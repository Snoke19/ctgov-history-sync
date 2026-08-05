import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import type { Endpoint } from '../endpoint.js';
import type { EndpointProvider } from '../types/endpointProvider.js';
import type { HttpTransport } from '../types/transport.js';
import { DirectEndpoint } from './directEndpoint.js';
import { logger } from '../../../config/logging.js';

/**
 * Creates a DirectEndpoint — requests go directly, without a proxy.
 *
 * To use axios instead of fetch, simply pass
 * `new AxiosTransport()` into the constructor.
 */
export class DirectEndpointProvider implements EndpointProvider {
    constructor(private readonly transport: HttpTransport) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        logger.info(`DirectEndpointProvider options are skipped! '${options}'`);
        return [new DirectEndpoint(createLimiter(), this.transport)];
    }
}
