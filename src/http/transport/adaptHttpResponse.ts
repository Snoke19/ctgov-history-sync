import { HttpResponse } from './httpTransport.js';

interface ResponseLike {
    readonly status: number;
    readonly statusText: string;
    readonly ok: boolean;
    readonly headers: Headers;
    readonly body: ReadableStream<unknown> | null;
    text(): Promise<string>;
    json(): Promise<unknown>;
}

export function adaptHttpResponse(response: ResponseLike): HttpResponse {
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
