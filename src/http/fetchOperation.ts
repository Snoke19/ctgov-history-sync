import { DEFAULT_USER_AGENT, FETCH_TIMEOUT_MS } from '../config/config.js';
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
import type { BusinessOperation } from '../retry/businessOperation.js';
import { defaultWallClock } from './clock.js';
import type { WallClock } from './clock.js';
import type { EndpointHandle } from './endpoint/endpoint.js';
import type { EndpointManager } from './endpoint/manager/endpointManager.js';
import { HTTP_METHOD_GET, type FetchJsonRequestOptions } from './http.js';
import { drainBody } from './responseBody.js';
import { parseRetryAfterHeader } from './retryPolicy.js';
import type { HttpResponse, HttpTransport } from './transport/httpTransport.js';

const logger = createLogger(import.meta.url);

type AbortKind = 'caller' | 'timeout';

const DEFAULT_REQUEST_HEADERS: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': DEFAULT_USER_AGENT,
};

const CANONICAL_HEADER_NAMES = new Map<string, string>([
    ['accept', 'Accept'],
    ['user-agent', 'User-Agent'],
]);

export class FetchOperation implements BusinessOperation<HttpResponse> {
    constructor(
        private readonly endpointManager: EndpointManager,
        private readonly url: string,
        private readonly options: FetchJsonRequestOptions,
        private readonly now: WallClock['now'] = defaultWallClock.now,
    ) {}

    async perform(): Promise<HttpResponse> {
        const controller = new AbortController();
        const callerSignal = this.options.signal;

        const forwardAbort = (): void => {
            controller.abort('caller');
        };

        if (callerSignal?.aborted) {
            forwardAbort();
        } else {
            callerSignal?.addEventListener('abort', forwardAbort, { once: true });
        }

        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        try {
            const endpoint = await this.acquireEndpoint(controller.signal);

            // The request timeout starts only after an endpoint is acquired.
            // Endpoint-pool wait time is governed separately by EndpointManager.
            timeoutId = setTimeout(() => {
                controller.abort('timeout');
            }, this.options.timeoutMs ?? FETCH_TIMEOUT_MS);

            return await this.executeRequest(endpoint, controller.signal);
        } catch (error: unknown) {
            /*
             * Capture the abort reason before performing defensive abort().
             * This preserves the actual source of cancellation:
             * caller > internal timeout > no abort.
             */
            const abortReason = controller.signal.reason;

            // Defensive abort: cancel any in-flight operation on the error path.
            controller.abort();

            // Caller cancellation always has precedence over internal timeout.
            // This guarantees caller cancellation can never accidentally become
            // a retryable TimeoutException.
            if (callerSignal?.aborted || abortReason === 'caller') {
                throw this.buildAbortError('caller', error);
            }

            // Endpoint acquisition has its own timeout domain and is exposed as
            // the standard retryable TimeoutException.
            if (error instanceof EndpointAcquisitionTimeoutError) {
                throw new TimeoutException(
                    `Endpoint acquisition timed out after ${error.timeoutMs}ms: ${this.sanitizedUrl()}`,
                    { cause: error },
                );
            }

            if (error instanceof CallerAbortedError) {
                throw this.buildAbortError('caller', error);
            }

            // If the internal request timeout caused the abort, preserve that
            // classification even if the transport returned a generic error.
            if (abortReason === 'timeout') {
                throw this.buildAbortError('timeout', error);
            }

            throw error;
        } finally {
            clearTimeout(timeoutId);
            callerSignal?.removeEventListener('abort', forwardAbort);
        }
    }

    private async acquireEndpoint(signal: AbortSignal): Promise<EndpointHandle> {
        return this.endpointManager.acquireEndpoint(signal);
    }

    private async executeRequest(endpoint: EndpointHandle, signal: AbortSignal): Promise<HttpResponse> {
        let response: HttpResponse;

        try {
            response = await endpoint.transport.request({
                url: this.url,
                method: HTTP_METHOD_GET,
                headers: this.buildHeaders(),
                signal,
            });
        } catch (error: unknown) {
            if (error instanceof TrialError) {
                throw error;
            }

            throw this.classifyTransportError(endpoint.transport, error, signal);
        }

        if (!response.ok) {
            const retryAfter = parseRetryAfterHeader(response, this.now());

            // Preserve the primary HTTP failure even if draining the body fails.
            try {
                await drainBody(response);
            } catch (error: unknown) {
                logger.debug(
                    {
                        error,
                        status: response.status,
                        url: this.sanitizedUrl(),
                    },
                    'Failed to drain non-success HTTP response body',
                );
            }

            throw new HttpException(
                `HTTP ${response.status} ${response.statusText} — GET ${this.sanitizedUrl()}`,
                response.status,
                retryAfter ?? undefined,
            );
        }

        return response;
    }

    private classifyTransportError(
        transport: HttpTransport,
        error: unknown,
        signal: AbortSignal,
    ): NetworkException | TimeoutException | CallerAbortedError | UnexpectedError {
        const classification = transport.classifyError(error);
        const cause = classification.cause;

        switch (classification.kind) {
            case 'timeout':
                return new TimeoutException(
                    `Request timed out after ${
                        this.options.timeoutMs ?? FETCH_TIMEOUT_MS
                    }ms: ${this.sanitizedUrl()} — cause: ${describeError(cause)}`,
                    { cause },
                );

            case 'cancelled': {
                const reason = signal.reason;

                if (reason === 'caller' || reason === 'timeout') {
                    return this.buildAbortError(reason, cause);
                }

                // A cancelled transport error without our own abort reason
                // should not be incorrectly classified as caller cancellation.
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

    /**
     * Maps an AbortKind to the correct typed error.
     *
     * Both perform() and the cancelled branch of classifyTransportError()
     * use this method so the mapping is defined in one place.
     */
    private buildAbortError(kind: AbortKind | unknown, cause: unknown): CallerAbortedError | TimeoutException {
        const causeDescription = describeError(cause);

        if (kind === 'timeout') {
            return new TimeoutException(
                `Request timed out after ${
                    this.options.timeoutMs ?? FETCH_TIMEOUT_MS
                }ms: ${this.sanitizedUrl()} — cause: ${causeDescription}`,
                { cause },
            );
        }

        return new CallerAbortedError(
            `Request cancelled by caller: ${this.sanitizedUrl()} — cause: ${causeDescription}`,
            { cause },
        );
    }

    private buildHeaders(): Record<string, string> {
        const headers = { ...DEFAULT_REQUEST_HEADERS };

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
            return '[invalid URL]';
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

        return code ? `${error.name} (${code}): ${error.message}` : `${error.name}: ${error.message}`;
    }

    if (typeof error === 'string') {
        return error;
    }

    try {
        const serialized = JSON.stringify(error);
        return serialized ?? String(error);
    } catch {
        return String(error);
    }
}
