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
import { sanitizeHttpUrl } from '../error/normalization/urlSanitizer.js';
import { ABORT_REASON_CALLER, ABORT_REASON_TIMEOUT, RequestAbortScope } from '../http/abort/requestAbortScope.js';
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

type ClassifiedTransportError = NetworkException | TimeoutException | UnexpectedError;

export interface FetchOperationDefaults {
    readonly requestAbortTimeoutMs: number;
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
        const callerAbortSignal = this.options.callerAbortSignal;
        const scope = new RequestAbortScope({
            callerAbortSignal,
            requestAbortTimeoutMs: this.getRequestAbortTimeoutMs(),
        });

        try {
            const endpoint = await this.endpointManager.acquireEndpoint(scope.requestAbortSignal);
            scope.startRequestAbortTimeout();
            return await this.executeRequest(endpoint, scope.requestAbortSignal);
        } catch (error: unknown) {
            throw this.handleOperationError(error, scope.requestAbortSignal);
        } finally {
            scope.dispose();
        }
    }

    private getRequestAbortTimeoutMs(): number {
        return this.options.requestAbortTimeoutMs ?? this.defaults.requestAbortTimeoutMs;
    }

    private handleOperationError(error: unknown, requestAbortSignal: AbortSignal): unknown {
        const abortReason = requestAbortSignal.reason;
        const callerAbortSignal = this.options.callerAbortSignal;

        if (callerAbortSignal?.aborted || abortReason === ABORT_REASON_CALLER) {
            return this.createCallerAbortedError(error);
        }

        if (error instanceof EndpointAcquisitionTimeoutError) {
            return new TimeoutException(
                `Endpoint acquisition timed out after ${error.endpointAcquireTimeoutMs}ms: ${this.sanitizedUrl()}`,
                { cause: error },
            );
        }

        if (error instanceof CallerAbortedError) {
            return this.createCallerAbortedError(error);
        }

        if (abortReason === ABORT_REASON_TIMEOUT) {
            return this.createRequestTimeoutError(error);
        }

        return error;
    }

    private createCallerAbortedError(cause: unknown): CallerAbortedError {
        return new CallerAbortedError(
            `Request cancelled by caller: ${this.sanitizedUrl()} — cause: ${this.describeError(cause)}`,
            { cause },
        );
    }

    private createRequestTimeoutError(cause: unknown): TimeoutException {
        return new TimeoutException(
            `Request timed out after ${this.getRequestAbortTimeoutMs()}ms: ${this.sanitizedUrl()} — cause: ${this.describeError(cause)}`,
            { cause },
        );
    }

    private async executeRequest(endpoint: EndpointHandle, requestAbortSignal: AbortSignal): Promise<HttpResponse> {
        const response = await this.request(endpoint, requestAbortSignal);

        if (response.ok) {
            return response;
        }

        return this.handleHttpError(response);
    }

    private async request(endpoint: EndpointHandle, requestAbortSignal: AbortSignal): Promise<HttpResponse> {
        try {
            return await endpoint.transport.request({
                url: this.url,
                method: HTTP_METHOD_GET,
                headers: this.buildHeaders(),
                requestAbortSignal,
            });
        } catch (error: unknown) {
            if (error instanceof TrialError) {
                throw error;
            }

            const reason = requestAbortSignal.reason;
            if (reason === ABORT_REASON_CALLER || reason === ABORT_REASON_TIMEOUT) {
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
                    `Request timed out after ${this.getRequestAbortTimeoutMs()}ms: ${this.sanitizedUrl()} — cause: ${this.describeError(cause)}`,
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
                    `Network failure: ${this.sanitizedUrl()} — cause: ${this.describeError(cause)}`,
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
            default: {
                const _exhaustiveCheck: never = classification.kind;
                void _exhaustiveCheck;
                return new UnexpectedError(cause);
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

    private sanitizedUrl(): string {
        return sanitizeHttpUrl(this.url);
    }

    /**
     * Produces a human-readable one-line description of any thrown value.
     * Named error codes (e.g. ECONNRESET) are included when present.
     */
    private describeError(error: unknown): string {
        if (error instanceof Error) {
            const code = 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
            const message = this.truncate(error.message);

            return code ? `${error.name} (${code}): ${message}` : `${error.name}: ${message}`;
        }

        if (typeof error === 'string') {
            return this.truncate(error);
        }

        return 'Unknown transport error';
    }

    private truncate(value: string): string {
        if (value.length <= MAX_ERROR_DESCRIPTION_LENGTH) {
            return value;
        }

        return `${value.slice(0, MAX_ERROR_DESCRIPTION_LENGTH)}…`;
    }
}
