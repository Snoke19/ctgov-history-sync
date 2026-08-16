import { DEFAULT_USER_AGENT, FETCH_TIMEOUT_MS } from '../config/config.js';
import {
    CallerAbortedError,
    EndpointAcquisitionTimeoutError,
    HttpException,
    NetworkException,
    TimeoutException,
    TrialError,
} from '../error/errors.js';
import { BusinessOperation } from '../retry/businessOperation.js';
import { defaultWallClock, WallClock } from './clock.js';
import { EndpointHandle } from './endpoint/endpoint.js';
import { EndpointManager } from './endpoint/manager/endpointManager.js';
import { FetchJsonRequestOptions } from './http.js';
import { drainBody } from './responseBody.js';
import { parseRetryAfterHeader } from './retryPolicy.js';
import { HttpResponse, HttpTransport } from './transport/httpTransport.js';

type AbortReason = 'caller' | 'timeout';

export class FetchOperation implements BusinessOperation<HttpResponse> {
    constructor(
        private readonly endpointManager: EndpointManager,
        private readonly url: string,
        private readonly options: FetchJsonRequestOptions,
        private readonly now: WallClock['now'] = defaultWallClock.now,
    ) {}

    async perform(): Promise<HttpResponse> {
        const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const controller = new AbortController();
        let abortReason: AbortReason | undefined;
        const callerSignal = this.options.signal;

        const forwardAbort = (): void => {
            abortReason = 'caller';
            controller.abort();
        };

        if (callerSignal?.aborted) {
            abortReason = 'caller';
            controller.abort();
        } else {
            callerSignal?.addEventListener('abort', forwardAbort, { once: true });
        }

        let succeeded = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        try {
            const endpoint = await this.acquireEndpoint(controller.signal);

            timeoutId = setTimeout(() => {
                abortReason = 'timeout';
                controller.abort();
            }, timeoutMs);

            const response = await this.executeRequest(endpoint, controller.signal, () => abortReason);

            succeeded = true;
            return response;
        } catch (error) {
            if (error instanceof CallerAbortedError) {
                throw this.mapAbortReason(error, abortReason, timeoutMs);
            }

            if (error instanceof EndpointAcquisitionTimeoutError) {
                throw new TimeoutException(`Endpoint acquisition timed out after ${error.timeoutMs}ms: ${this.url}`);
            }

            throw error;
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }

            callerSignal?.removeEventListener('abort', forwardAbort);

            if (!succeeded) {
                controller.abort();
            }
        }
    }

    private async acquireEndpoint(signal: AbortSignal): Promise<EndpointHandle> {
        return this.endpointManager.acquireEndpoint(signal);
    }

    private async executeRequest(
        endpoint: EndpointHandle,
        signal: AbortSignal,
        getAbortReason: () => AbortReason | undefined,
    ): Promise<HttpResponse> {
        const method = 'GET';

        let response: HttpResponse;

        try {
            response = await endpoint.transport.request({
                url: this.url,
                method,
                headers: this.buildHeaders(),
                signal,
            });
        } catch (error: unknown) {
            if (error instanceof TrialError) {
                throw error;
            }

            throw this.classifyTransportError(endpoint.transport, error, getAbortReason());
        }

        if (!response.ok) {
            const retryAfter = parseRetryAfterHeader(response, this.now());

            await drainBody(response);

            throw new HttpException(
                `HTTP ${response.status} ${response.statusText} — ${method} ${this.url}`,
                response.status,
                retryAfter ?? undefined,
            );
        }

        return response;
    }

    private classifyTransportError(
        transport: HttpTransport,
        error: unknown,
        abortReason: AbortReason | undefined,
    ): NetworkException | TimeoutException | CallerAbortedError {
        const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const classification = transport.classifyError(error);
        const causeDescription = this.describeError(classification.cause);

        switch (classification.kind) {
            case 'timeout':
                return new TimeoutException(
                    `Request timed out after ${timeoutMs}ms: ${this.url} — cause: ${causeDescription}`,
                    { cause: classification.cause },
                );

            case 'cancelled':
                return this.mapAbortReason(classification.cause, abortReason, timeoutMs);

            case 'network':
                return new NetworkException(`Network failure: ${this.url} — cause: ${causeDescription}`, {
                    cause: classification.cause,
                });
        }
    }

    private mapAbortReason(
        cause: unknown,
        abortReason: AbortReason | undefined,
        timeoutMs: number,
    ): CallerAbortedError | TimeoutException {
        const causeDescription = this.describeError(cause);

        if (abortReason === 'caller') {
            return new CallerAbortedError(`Request cancelled by caller: ${this.url} — cause: ${causeDescription}`, {
                cause,
            });
        }

        return new TimeoutException(
            `Request timed out after ${timeoutMs}ms: ${this.url} — cause: ${causeDescription}`,
            { cause },
        );
    }

    private buildHeaders(): Record<string, string> {
        const defaults: Record<string, string> = {
            Accept: 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
        };

        const KNOWN_KEYS = new Map([
            ['accept', 'Accept'],
            ['user-agent', 'User-Agent'],
        ]);

        for (const [key, value] of Object.entries(this.options.headers ?? {})) {
            const canonical = KNOWN_KEYS.get(key.toLowerCase());
            defaults[canonical ?? key] = value;
        }

        return defaults;
    }

    private describeError(error: unknown): string {
        if (error instanceof Error) {
            const code = 'code' in error ? error.code : undefined;

            return code ? `${error.name} (${code}): ${error.message}` : `${error.name}: ${error.message}`;
        }

        if (typeof error === 'string') {
            return error;
        }

        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
}
