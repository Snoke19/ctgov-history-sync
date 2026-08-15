import { ConfigurationError } from '../../../../error/errors.js';
import { assertPositiveInt } from '../../../../utils/validation.js';
import { ProxyTransportContext, ProxyTransportFactory } from '../../../transport/factory/proxyTransportFactory.js';
import { ProxyUrlParser } from '../../proxy/httpProxyUrlParser.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

export interface ProxyEndpointProviderOptions {
    readonly proxyUrls: string;
    readonly concurrency: number;
}

export class ProxyEndpointProvider implements EndpointProvider {
    constructor(
        private readonly transportFactory: ProxyTransportFactory,
        private readonly urlParser: ProxyUrlParser,
        private readonly options: ProxyEndpointProviderOptions,
    ) {}

    build(): EndpointDefinition[] {
        assertPositiveInt(this.options.concurrency, 'concurrency');

        const urls = this.urlParser.parse(this.options.proxyUrls);

        if (urls.length === 0) {
            throw new ConfigurationError('No valid proxy URLs were configured.');
        }

        const context: ProxyTransportContext = {
            concurrency: this.options.concurrency,
            proxyCount: urls.length,
        };

        return urls.map((urlProxy) => ({
            id: urlProxy,
            createTransport: () => this.transportFactory.create(urlProxy, context),
        }));
    }
}
