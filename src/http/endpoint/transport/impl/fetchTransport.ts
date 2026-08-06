import { HttpRequest, HttpResponse, HttpTransport } from '../httpTransport.js';

export class FetchDirectTransport implements HttpTransport {
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
