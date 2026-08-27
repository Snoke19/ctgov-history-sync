import { createLogger } from '../../../../config/logging.js';
import { FetchDirectTransport } from '../../../transport/impl/fetchDirectTransport.js';
import { EndpointDefinition, EndpointProvider } from '../endpointProvider.js';

const logger = createLogger(import.meta.url);

export class DirectEndpointProvider implements EndpointProvider {
    build(): EndpointDefinition[] {
        logger.info({ endpointMode: 'direct' }, 'Direct endpoint configured');

        return [
            {
                id: 'direct',
                createTransport: () => new FetchDirectTransport(),
            },
        ];
    }
}
