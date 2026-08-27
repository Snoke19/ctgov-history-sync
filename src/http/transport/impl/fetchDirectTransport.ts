import { adaptHttpResponse } from '../adaptHttpResponse.js';
import { classifyTransportError, TransportErrorPredicates } from '../classifyTransportError.js';
import { DirectTransportFactory } from '../factory/directTransportFactory.js';
import type { HttpRequest, HttpResponse, HttpTransport, TransportErrorClassification } from '../httpTransport.js';

export class FetchDirectTransport implements HttpTransport {
    async request(options: HttpRequest): Promise<HttpResponse> {
        const requestAbortSignal = options.requestAbortSignal;
        if (!requestAbortSignal) throw new Error('requestAbortSignal is required');
        const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            signal: requestAbortSignal,
        });

        return adaptHttpResponse(response);
    }

    classifyError(error: unknown): TransportErrorClassification {
        return classifyTransportError(error, fetchErrorPredicates);
    }

    async close(): Promise<void> {}
}

export class FetchDirectTransportFactory implements DirectTransportFactory {
    create(): HttpTransport {
        return new FetchDirectTransport();
    }
}

const fetchErrorPredicates: TransportErrorPredicates = {
    isAbortError: (error) => error.name === 'AbortError',

    isTimeoutError: () => false,

    isNetworkError: (error) =>
        error.name === 'TypeError' && typeof error.message === 'string' && /fetch failed/i.test(error.message),
};
