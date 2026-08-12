import { HttpRequest, HttpResponse, HttpTransport, TransportErrorClassification } from '../httpTransport.js';

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

    classifyError(error: unknown): TransportErrorClassification {
        if (this.isAbortError(error)) {
            return {
                kind: 'cancelled',
                cause: error,
            };
        }

        return {
            kind: 'network',
            cause: error,
        };
    }

    async close(): Promise<void> {}

    private isAbortError(error: unknown): boolean {
        if (error === null || typeof error !== 'object') {
            return false;
        }

        if ('name' in error && error.name === 'AbortError') {
            return true;
        }

        if ('code' in error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
            return true;
        }

        return false;
    }
}
