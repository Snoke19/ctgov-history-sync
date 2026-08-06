import { HttpRequest, HttpResponse, HttpTransport } from './transport.js';

/**
 * Factory for creating a direct (non-proxy) HTTP transport.
 *
 * Deliberately kept separate from {@link TransportFactory} so the direct
 * transport path carries no proxy-specific parameters (proxyUrl, proxyCount,
 * poolConfig), and each can evolve independently.
 *
 * To swap the HTTP library for direct requests:
 *   1. Implement `HttpTransport` (e.g. `AxiosDirectTransport`).
 *   2. Implement this interface (e.g. `AxiosDirectTransportFactory`).
 *   3. Pass the factory to {@link DirectEndpointProvider} at the composition root.
 */
export interface DirectTransportFactory {
    create(): HttpTransport;
}

export class FetchTransport implements HttpTransport {
    async request(options: HttpRequest): Promise<HttpResponse> {
        const response = await fetch(options.url, {
            method: options.method,
            headers: options.headers,
            ...(options.body !== undefined && { body: options.body }),
            ...(options.signal !== undefined && { signal: options.signal }),
        });

        return {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers: response.headers,
            text: () => response.text(),
            json: () => response.json(),
            discard: async () => {
                if (response.body) {
                    await response.body.cancel().catch(() => {});
                }
            },
        };
    }

    async close(): Promise<void> {}
}
