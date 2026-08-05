/**
 * Abstraction over a specific HTTP library (undici, axios, node-fetch, etc.).
 *
 * The `request` method intentionally accepts `unknown` to avoid coupling
 * the interface to the types of a specific library. Each implementation performs
 * internal type casting.
 *
 * To add axios in the future:
 *   1. Create `AxiosHttpTransport` that implements this interface.
 *   2. Create `AxiosTransportFactory` that implements `TransportFactory`.
 *   3. Pass it to `ProxyEndpointFactory` instead of (or alongside)
 *      `UndiciTransportFactory`.
 */
export interface HttpTransport {
    request(options: HttpRequest): Promise<HttpResponse>;
    close(): Promise<void>;
}

export interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Buffer | Uint8Array | null;
    readonly signal?: AbortSignal;
}

export interface HttpResponse {
    readonly status: number;
    readonly statusText: string;
    readonly ok: boolean;
    readonly headers: Headers;
    text(): Promise<string>;
    json(): Promise<unknown>;
    discard(): Promise<void>;
}
