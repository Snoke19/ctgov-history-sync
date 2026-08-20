export type TransportErrorKind = 'timeout' | 'cancelled' | 'network' | 'unknown';

export interface TransportErrorClassification {
    readonly kind: TransportErrorKind;
    readonly cause: unknown;
}

export interface HttpTransport {
    request(options: HttpRequest): Promise<HttpResponse>;
    classifyError(error: unknown): TransportErrorClassification;
    close(): Promise<void>;
}

export interface HttpRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly signal: AbortSignal;
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
