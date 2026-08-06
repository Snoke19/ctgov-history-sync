import { DEFAULT_USER_AGENT, FETCH_TIMEOUT_MS } from '../config/config.js';
import { EndpointAcquisitionTimeoutError } from '../error/errors.js';
import { EndpointHandle } from './endpoint/endpoint.js';
import { EndpointManager } from './endpoint/manager/endpointManager.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';
import { BusinessException } from './retry/businessException.js';
import { HttpException, NetworkException, TimeoutException } from './retry/exceptions.js';
import { parseRetryAfterHeader } from './retry/retryPolicy.js';
import { FetchJsonRequestOptions } from './types/http.js';
import { BusinessOperation } from './retry/businessOperation.js';

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'AbortError') return true;
    if (error !== null && typeof error === 'object') {
        if ('name' in error && error.name === 'AbortError') return true;
        if ('code' in error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') return true;
    }
    return false;
}

export class FetchOperation implements BusinessOperation<HttpResponse> {
    constructor(
        private readonly endpointManager: EndpointManager,
        private readonly url: string,
        private readonly options: FetchJsonRequestOptions,
    ) {}

    async perform(): Promise<HttpResponse> {
        const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const deadline = this.options.deadline ?? Date.now() + timeoutMs;

        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
            timeoutMs,
        );

        const signal = this.options.signal
            ? AbortSignal.any([controller.signal, this.options.signal])
            : controller.signal;

        try {
            const remainingMs = getRemainingBudget(deadline, this.url, timeoutMs);
            const endpoint = await this.acquireEndpoint(remainingMs, signal);
            return await this.executeRequest(endpoint, signal);
        } finally {
            clearTimeout(timeoutId);
            // Do NOT abort the controller here. On success, the response body is
            // consumed by the caller after perform() returns; aborting the signal
            // at this point would prematurely terminate the body stream.
        }
    }

    private async acquireEndpoint(
        remainingMs: number,
        signal: AbortSignal,
    ): Promise<EndpointHandle> {
        try {
            return await this.endpointManager.acquireEndpoint(remainingMs, signal);
        } catch (error) {
            if (error instanceof EndpointAcquisitionTimeoutError) {
                throw new TimeoutException(
                    `Endpoint acquisition timed out after ${remainingMs}ms: ${this.url}`,
                );
            }
            throw error;
        }
    }

    private async executeRequest(
        endpoint: EndpointHandle,
        signal: AbortSignal,
    ): Promise<HttpResponse> {
        const method = this.options.method ?? 'GET';
        let response: HttpResponse;

        try {
            response = await endpoint.transport.request({
                url: this.url,
                method,
                headers: this.buildHeaders(),
                body: this.options.body,
                signal,
            });
        } catch (error) {
            if (error instanceof BusinessException) throw error;
            throw this.normalizeTransportError(error);
        }

        if (!response.ok) {
            const retryAfter = parseRetryAfterHeader(response);
            throw new HttpException(
                `HTTP ${response.status} ${response.statusText} — ${method} ${this.url}`,
                response.status,
                retryAfter ?? undefined,
            );
        }

        return response;
    }

    private buildHeaders(): Record<string, string> {
        return {
            Accept: 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
            ...this.options.headers,
        };
    }

    private normalizeTransportError(error: unknown): NetworkException | TimeoutException {
        const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;

        if (isAbortError(error)) {
            if (this.options.signal?.aborted) {
                return new NetworkException(`Request cancelled by caller: ${this.url}`, error);
            }
            return new TimeoutException(`Request timed out after ${timeoutMs}ms: ${this.url}`);
        }

        return new NetworkException(`Network failure: ${this.url}`, error);
    }
}

/**
 * Returns the milliseconds remaining before the deadline expires.
 * Throws TimeoutException (a BusinessException) if the budget is already exhausted,
 * so Retry can intercept it like any other retryable error.
 */
function getRemainingBudget(deadline: number, url: string, totalBudgetMs: number): number {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
        throw new TimeoutException(`Deadline exhausted (budget: ${totalBudgetMs}ms): ${url}`);
    }
    return remainingMs;
}
