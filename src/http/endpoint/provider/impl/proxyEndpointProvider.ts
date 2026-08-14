import { ConfigurationError } from '../../../../error/errors.js';
import { assertPositiveInt } from '../../../../utils/validation.js';
import type { HttpClientOptions } from '../../../http.js';
import { ProxyTransportFactory } from '../../../transport/factory/proxyTransportFactory.js';
import { CreateProxyEndpointsOptions } from '../../../transport/httpTransport.js';
import { ProxyUrlParser } from '../../proxy/httpProxyUrlParser.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

export class ProxyEndpointProvider implements EndpointProvider {
    constructor(
        private readonly transportFactory: ProxyTransportFactory,
        private readonly urlParser: ProxyUrlParser,
    ) {}

    build(options: HttpClientOptions): EndpointDefinition[] {
        assertPositiveInt(options.concurrency, 'concurrency');

        if (!options.poolConfig) {
            throw new ConfigurationError('poolConfig is required when useProxy is enabled.');
        }

        const urls = this.urlParser.parse(options.proxyUrls ?? '');

        if (urls.length === 0) {
            throw new ConfigurationError('No valid proxy URLs were configured.');
        }

        const transportOptions: CreateProxyEndpointsOptions = {
            concurrency: options.concurrency,
            proxyCount: urls.length,
            poolConfig: options.poolConfig,
        };

        return urls.map((urlProxy) => ({
            id: urlProxy,
            createTransport: () => this.transportFactory.create(urlProxy, transportOptions),
        }));
    }
}
