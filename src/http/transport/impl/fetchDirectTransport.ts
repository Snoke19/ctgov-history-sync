import { adaptHttpResponse } from '../adaptHttpResponse.js';
import { classifyTransportError } from '../classifyTransportError.js';
import type { HttpRequest, HttpResponse, HttpTransport, TransportErrorClassification } from '../httpTransport.js';

export class FetchDirectTransport implements HttpTransport {
    async request(options: HttpRequest): Promise<HttpResponse> {
        const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            ...(options.body !== undefined && { body: options.body }),
            ...(options.signal !== undefined && { signal: options.signal }),
        });

        return adaptHttpResponse(response);
    }

    classifyError(error: unknown): TransportErrorClassification {
        return classifyTransportError(error);
    }

    async close(): Promise<void> {}
}
