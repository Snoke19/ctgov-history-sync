import { ConfigurationError } from '../../../error/errors.js';
import type { HttpClientOptions } from '../../types/http.js';
import type { Limiter } from '../../limiter/limiter.js';
import { Endpoint } from '../endpoint.js';
import { parseProxyUrls } from '../proxy/proxyUrlParser.js';
import { assertPositiveInt } from '../../../utils/validation.js';
import { ProxyTransportFactory } from '../transport/factory/transportFactory.js';
import { CreateProxyEndpointsOptions } from '../transport/httpTransport.js';
import { EndpointProvider } from './endpointProvider.js';

export class ProxyEndpointProvider implements EndpointProvider {
    constructor(private readonly transportFactory: ProxyTransportFactory) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
        assertPositiveInt(options.concurrency, 'concurrency');

        if (!options.poolConfig) {
            throw new ConfigurationError('poolConfig is required when useProxy is enabled.');
        }

        const urls = parseProxyUrls(options.proxyUrls ?? '');

        if (urls.length === 0) {
            throw new ConfigurationError('No valid proxy URLs were configured.');
        }

        const transportOptions: CreateProxyEndpointsOptions = {
            concurrency: options.concurrency,
            proxyCount: urls.length,
            poolConfig: options.poolConfig,
        };

        return urls.map(
            (urlProxy) =>
                new Endpoint(
                    urlProxy,
                    createLimiter(),
                    this.transportFactory.create(urlProxy, transportOptions),
                ),
        );
    }
}
