import { ConfigurationError } from '../../../error/errors.js';
import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import { Endpoint } from '../endpoint.js';
import type { EndpointProvider } from '../types/endpointProvider.js';
import { parseProxyUrls } from './proxyEndpoints.js';
import type { TransportFactory } from '../types/transportFactory.js';

export class ProxyEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: TransportFactory) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        if (!options.poolConfig) {
            throw new ConfigurationError('poolConfig is required when useProxy is enabled.');
        }

        const urls = parseProxyUrls(options.proxyUrls ?? '');

        if (urls.length === 0) {
            throw new ConfigurationError('No valid proxy URLs were configured.');
        }

        const transportOptions = {
            concurrency: options.concurrency,
            proxyCount: urls.length,
            poolConfig: options.poolConfig,
        };

        return urls.map(
            (url) =>
                new Endpoint(
                    url,
                    createLimiter(),
                    this.transportFactory.create(url, transportOptions),
                ),
        );
    }
}
