import { createLogger } from '../config/logging.js';
import {
    CallerAbortedError,
    EndpointAcquisitionTimeoutError,
    HttpException,
    NetworkException,
    TimeoutException,
    TrialError,
    UnexpectedError,
} from '../error/errors.js';
import { defaultWallClock, WallClock } from '../http/clock.js';
import { EndpointHandle } from '../http/endpoint/endpoint.js';
import { EndpointManager } from '../http/endpoint/manager/endpointManager.js';
import { FetchJsonRequestOptions, HTTP_METHOD_GET } from '../http/http.js';
import { drainBody } from '../http/responseBody.js';
import { HttpResponse, HttpTransport } from '../http/transport/httpTransport.js';
import type { BusinessOperation } from '../retry/businessOperation.js';
import { parseRetryAfterHeader } from '../retry/retryPolicy.js';

const MAX_ERROR_DESCRIPTION_LENGTH = 256;
const logger = createLogger(import.meta.url);
const CANONICAL_HEADER_NAMES = new Map<string, string>([
    ['accept', 'Accept'],
    ['user-agent', 'User-Agent'],
]);

type TimeoutId = ReturnType<typeof setTimeout>;
type ClassifiedTransportError = NetworkException | TimeoutException | UnexpectedError;

export interface FetchOperationDefaults {
    readonly timeoutMs: number;
    readonly userAgent: string;
}

export class FetchOperation implements BusinessOperation<HttpResponse> {
    constructor(
        private readonly endpointManager: EndpointManager,
        private readonly url: string,
        private readonly options: FetchJsonRequestOptions,
        private readonly defaults: FetchOperationDefaults,
        private readonly now: WallClock['now'] = defaultWallClock.now,
    ) {}

    async perform(): Promise<HttpResponse> {
        const controller = new AbortController();
        const removeCallerAbortListener = this.attachCallerAbort(controller);

        let timeoutId: TimeoutId | undefined;

        try {
            const endpoint = await this.acquireEndpoint(controller.signal);

            timeoutId = this.startRequestTimeout(controller);

            return await this.executeRequest(endpoint, controller.signal);
        } catch (error: unknown) {
            throw this.handleOperationError(error, controller.signal);
        } finally {
            clearTimeout(timeoutId);
            removeCallerAbortListener();
        }
    }

    private attachCallerAbort(controller: AbortController): () => void {
        const callerSignal = this.options.signal;

        if (!callerSignal) {
            return () => {};
        }

        const forwardAbort = (): void => {
            controller.abort('caller');
        };

        if (callerSignal.aborted) {
            forwardAbort();
        } else {
            callerSignal.addEventListener('abort', forwardAbort, { once: true });
        }

        return () => {
            callerSignal.removeEventListener('abort', forwardAbort);
        };
    }

    private startRequestTimeout(controller: AbortController): TimeoutId {
        return setTimeout(() => {
            controller.abort('timeout');
        }, this.getRequestTimeoutMs());
    }

    private getRequestTimeoutMs(): number {
        return this.options.timeoutMs ?? this.defaults.timeoutMs;
    }

    private handleOperationError(error: unknown, signal: AbortSignal): unknown {
        const abortReason = signal.reason;

        if (this.options.signal?.aborted || abortReason === 'caller') {
            return this.createCallerAbortedError(error);
        }

        if (error instanceof EndpointAcquisitionTimeoutError) {
            return new TimeoutException(
                `Endpoint acquisition timed out after ${error.timeoutMs}ms: ${this.sanitizedUrl()}`,
                { cause: error },
            );
        }

        if (error instanceof CallerAbortedError) {
            return this.createCallerAbortedError(error);
        }

        if (abortReason === 'timeout') {
            return this.createRequestTimeoutError(error);
        }

        return error;
    }

    private createCallerAbortedError(cause: unknown): CallerAbortedError {
        return new CallerAbortedError(
            `Request cancelled by caller: ${this.sanitizedUrl()} — cause: ${describeError(cause)}`,
            { cause },
        );
    }

    private createRequestTimeoutError(cause: unknown): TimeoutException {
        return new TimeoutException(
            `Request timed out after ${this.getRequestTimeoutMs()}ms: ${this.sanitizedUrl()} — cause: ${describeError(cause)}`,
            { cause },
        );
    }

    private async acquireEndpoint(signal: AbortSignal): Promise<EndpointHandle> {
        return this.endpointManager.acquireEndpoint(signal);
    }

    private async executeRequest(endpoint: EndpointHandle, signal: AbortSignal): Promise<HttpResponse> {
        const response = await this.request(endpoint, signal);

        if (response.ok) {
            return response;
        }

        return this.handleHttpError(response);
    }

    private async request(endpoint: EndpointHandle, signal: AbortSignal): Promise<HttpResponse> {
        try {
            return await endpoint.transport.request({
                url: this.url,
                method: HTTP_METHOD_GET,
                headers: this.buildHeaders(),
                signal,
            });
        } catch (error: unknown) {
            if (error instanceof TrialError) {
                throw error;
            }

            const reason = signal.reason;
            if (reason === 'caller' || reason === 'timeout') {
                throw error;
            }

            throw this.classifyTransportError(endpoint.transport, error);
        }
    }

    private async handleHttpError(response: HttpResponse): Promise<never> {
        const retryAfter = parseRetryAfterHeader(response, this.now());

        await drainBody(response);

        throw new HttpException(
            `HTTP ${response.status} ${response.statusText} — GET ${this.sanitizedUrl()}`,
            response.status,
            retryAfter ?? undefined,
        );
    }

    private classifyTransportError(transport: HttpTransport, error: unknown): ClassifiedTransportError {
        const classification = transport.classifyError(error);
        const cause = classification.cause;

        switch (classification.kind) {
            case 'timeout':
                return new TimeoutException(
                    `Request timed out after ${this.getRequestTimeoutMs()}ms: ${this.sanitizedUrl()} — cause: ${describeError(cause)}`,
                    { cause },
                );
            case 'cancelled': {
                const unexpectedError = new UnexpectedError(cause);

                logger.debug(
                    {
                        errorType: unexpectedError.name,
                        err: unexpectedError,
                    },
                    'Transport reported cancellation without a known abort reason; retry disabled',
                );

                return unexpectedError;
            }

            case 'network':
                return new NetworkException(
                    `Network failure: ${this.sanitizedUrl()} — cause: ${describeError(cause)}`,
                    { cause },
                );

            case 'unknown': {
                const unexpectedError = new UnexpectedError(cause);

                logger.debug(
                    {
                        errorType: unexpectedError.name,
                        err: unexpectedError,
                    },
                    'Unknown transport error; retry disabled',
                );

                return unexpectedError;
            }
        }
    }

    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': this.defaults.userAgent,
        };

        for (const [key, value] of Object.entries(this.options.headers ?? {})) {
            const canonical = CANONICAL_HEADER_NAMES.get(key.toLowerCase());

            headers[canonical ?? key] = value;
        }

        return headers;
    }

    /**
     * Removes credentials, query parameters and fragments from the URL used
     * in exception messages and logs.
     *
     * If the URL is invalid, deliberately return a safe placeholder instead
     * of exposing potentially sensitive raw input.
     */
    private sanitizedUrl(): string {
        try {
            const url = new URL(this.url);

            return `${url.protocol}//${url.host}${url.pathname}`;
        } catch {
            return '<invalid URL>';
        }
    }
}

/**
 * Produces a human-readable one-line description of any thrown value.
 * Named error codes (e.g. ECONNRESET) are included when present.
 */
function describeError(error: unknown): string {
    if (error instanceof Error) {
        const code = 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
        const message = truncate(error.message);

        return code ? `${error.name} (${code}): ${message}` : `${error.name}: ${message}`;
    }

    if (typeof error === 'string') {
        return truncate(error);
    }

    return 'Unknown transport error';
}

function truncate(value: string): string {
    if (value.length <= MAX_ERROR_DESCRIPTION_LENGTH) {
        return value;
    }

    return `${value.slice(0, MAX_ERROR_DESCRIPTION_LENGTH)}…`;
}
