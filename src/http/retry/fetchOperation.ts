import { DEFAULT_USER_AGENT, FETCH_TIMEOUT_MS } from '../../config/config.js';
import { CallerAbortedError, EndpointAcquisitionTimeoutError } from '../../error/errors.js';
import { EndpointHandle } from '../endpoint/endpoint.js';
import { EndpointManager } from '../endpoint/manager/endpointManager.js';
import { HttpResponse } from '../endpoint/transport/httpTransport.js';
import { BusinessException } from './businessException.js';
import { HttpException, NetworkException, TimeoutException } from './exceptions.js';
import { parseRetryAfterHeader } from './retryPolicy.js';
import { FetchJsonRequestOptions } from '../types/http.js';
import { BusinessOperation } from './businessOperation.js';
import { drainBody } from '../responseBody.js';

function isAbortError(error: unknown): boolean {
    if (error instanceof CallerAbortedError) return true;
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
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const signal = this.options.signal
            ? AbortSignal.any([controller.signal, this.options.signal])
            : controller.signal;

        try {
            const remainingMs = getRemainingBudget(deadline, this.url, timeoutMs);
            const endpoint = await this.acquireEndpoint(remainingMs, signal);
            return await this.executeRequest(endpoint, signal);
        } catch (error) {
            if (isAbortError(error)) {
                if (this.options.signal?.aborted) {
                    throw new NetworkException(`Request cancelled by caller: ${this.url}`, error);
                }
                throw new TimeoutException(`Request timed out after ${timeoutMs}ms: ${this.url}`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async acquireEndpoint(remainingMs: number, signal: AbortSignal): Promise<EndpointHandle> {
        try {
            return await this.endpointManager.acquireEndpoint(remainingMs, signal);
        } catch (error) {
            if (error instanceof EndpointAcquisitionTimeoutError) {
                throw new TimeoutException(`Endpoint acquisition timed out after ${remainingMs}ms: ${this.url}`);
            }
            throw error;
        }
    }

    private async executeRequest(endpoint: EndpointHandle, signal: AbortSignal): Promise<HttpResponse> {
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
            await drainBody(response);
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

function getRemainingBudget(deadline: number, url: string, totalBudgetMs: number): number {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
        throw new TimeoutException(`Deadline exhausted (budget: ${totalBudgetMs}ms): ${url}`);
    }
    return remainingMs;
}
