import { ConfigurationError } from '../../../../error/errors.js';
import { assertPositiveInt } from '../../../../utils/validation.js';
import type { Limiter } from '../../../limiter/limiter.js';
import type { HttpClientOptions } from '../../../types/http.js';
import { Endpoint } from '../../endpoint.js';
import { ProxyUrlParser } from '../../proxy/httpProxyUrlParser.js';
import { ProxyTransportFactory } from '../../transport/factory/proxyTransportFactory.js';
import { CreateProxyEndpointsOptions } from '../../transport/httpTransport.js';
import { EndpointProvider } from '../endpointProvider.js';

export class ProxyEndpointProvider implements EndpointProvider {
    constructor(
        private readonly transportFactory: ProxyTransportFactory,
        private readonly urlParser: ProxyUrlParser,
    ) {}

    build(options: HttpClientOptions, createLimiter: () => Limiter): Endpoint[] {
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

        const endpoints: Endpoint[] = [];
        try {
            for (const urlProxy of urls) {
                const transport = this.transportFactory.create(urlProxy, transportOptions);
                try {
                    endpoints.push(new Endpoint(urlProxy, createLimiter(), transport));
                } catch (err) {
                    void transport.close();
                    throw err;
                }
            }
        } catch (err) {
            // Close all endpoints constructed so far to prevent socket/timer leaks.
            for (const endpoint of endpoints) {
                void endpoint.close();
            }
            throw err;
        }
        return endpoints;
    }
}
