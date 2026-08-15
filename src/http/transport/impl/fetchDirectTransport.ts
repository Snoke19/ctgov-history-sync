import { createLogger } from '../../../config/logging.js';
import { adaptHttpResponse } from '../adaptHttpResponse.js';
import { classifyTransportError } from '../classifyTransportError.js';
import { DirectTransportFactory } from '../factory/directTransportFactory.js';
import type { HttpRequest, HttpResponse, HttpTransport, TransportErrorClassification } from '../httpTransport.js';

const logger = createLogger(import.meta.url);

export class FetchDirectTransport implements HttpTransport {
    async request(options: HttpRequest): Promise<HttpResponse> {
        const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            signal: options.signal,
        });

        return adaptHttpResponse(response);
    }

    classifyError(error: unknown): TransportErrorClassification {
        return classifyTransportError(error);
    }

    async close(): Promise<void> {
        logger.debug('Direct transport closed');
    }
}

export class FetchDirectTransportFactory implements DirectTransportFactory {
    create(): HttpTransport {
        logger.debug('Direct transport created');

        return new FetchDirectTransport();
    }
}
