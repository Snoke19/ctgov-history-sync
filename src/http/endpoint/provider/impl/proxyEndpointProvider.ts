import { createLogger } from '../../../../config/logging.js';
import { ConfigurationError } from '../../../../error/errors.js';
import { assertPositiveInt } from '../../../../utils/validation.js';
import { ProxyTransportContext, ProxyTransportFactory } from '../../../transport/factory/proxyTransportFactory.js';
import { ProxyUrlParser } from '../../proxy/httpProxyUrlParser.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

const logger = createLogger(import.meta.url);

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
            const error = new ConfigurationError('No valid proxy URLs were configured.');

            logger.error(
                {
                    err: error,
                    configuredProxyCount: this.options.proxyUrls ? this.options.proxyUrls.split(',').length : 0,
                },
                'Proxy endpoint configuration failed',
            );

            throw error;
        }

        logger.info({ proxyCount: urls.length, concurrency: this.options.concurrency }, 'Proxy endpoints configured');

        logger.debug({ resolvedProxyEndpoints: urls.map(sanitizeProxyUrl) }, 'Proxy endpoints resolved');

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

function sanitizeProxyUrl(value: string): string {
    try {
        const url = new URL(value);

        return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return '<invalid proxy URL>';
    }
}
