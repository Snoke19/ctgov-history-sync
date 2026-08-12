import { DEFAULT_USER_AGENT, FETCH_TIMEOUT_MS } from '../../config/config.js';
import {
    CallerAbortedError,
    EndpointAcquisitionTimeoutError,
    HttpException,
    NetworkException,
    TimeoutException,
    TrialError,
} from '../../error/errors.js';
import { EndpointHandle } from '../endpoint/endpoint.js';
import { EndpointManager } from '../endpoint/manager/endpointManager.js';
import { HttpResponse } from '../endpoint/transport/httpTransport.js';
import { drainBody } from '../responseBody.js';
import { defaultClock } from '../types/clock.js';
import type { Clock } from '../types/clock.js';
import { FetchJsonRequestOptions } from '../types/http.js';
import { BusinessOperation } from './businessOperation.js';
import { parseRetryAfterHeader } from './retryPolicy.js';

function isAbortError(error: unknown): boolean {
    if (error instanceof CallerAbortedError) return true;
    if (error !== null && typeof error === 'object') {
        if ('name' in error && error.name === 'AbortError') return true;
        if ('code' in error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') return true;
    }
    return false;
}

function classifyAbortError(
    error: unknown,
    url: string,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
): NetworkException | TimeoutException {
    if (callerSignal?.aborted) {
        return new NetworkException(`Request cancelled by caller: ${url}`, error);
    }
    return new TimeoutException(`Request timed out after ${timeoutMs}ms: ${url}`);
}

export class FetchOperation implements BusinessOperation<HttpResponse> {
    /**
     * @param clock   Clock source for budget/deadline math. Defaults to the
     *                shared HTTP-layer clock (`Date.now()`, epoch ms) — the
     *                same source EndpointManager and TokenBucket use, so a
     *                single injected clock can never drift against the
     *                deadline arithmetic.
     */
    constructor(
        private readonly endpointManager: EndpointManager,
        private readonly url: string,
        private readonly options: FetchJsonRequestOptions,
        private readonly clock: Clock['now'] = defaultClock.now,
    ) {}

    async perform(): Promise<HttpResponse> {
        const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const deadline = this.options.deadline ?? this.clock() + timeoutMs;

        const controller = new AbortController();

        // Compose the caller's signal into the controller we own instead of
        // AbortSignal.any, which keeps an abort listener attached to the
        // caller's (possibly long-lived) signal until IT aborts — on every
        // successful request that listener would otherwise accumulate. We
        // attach our own listener and always detach it in `finally`.
        // The `{ once: true }` only guards against stray duplicate events;
        // the successful-path cleanup is the removeEventListener below.
        const callerSignal = this.options.signal;
        const forwardAbort = (): void => controller.abort();
        if (callerSignal?.aborted) {
            controller.abort();
        } else {
            callerSignal?.addEventListener('abort', forwardAbort, { once: true });
        }

        let succeeded = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
            const remainingMs = this.getRemainingBudget(deadline, timeoutMs);
            // Bound the per-attempt timer by the remaining budget so the
            // global deadline is respected end-to-end.
            const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
            timeoutId = setTimeout(() => controller.abort(), attemptTimeoutMs);

            const endpoint = await this.acquireEndpoint(remainingMs, controller.signal);
            const response = await this.executeRequest(endpoint, controller.signal);
            succeeded = true;
            return response;
        } catch (error) {
            if (isAbortError(error)) {
                throw classifyAbortError(error, this.url, this.options.signal, timeoutMs);
            }
            throw error;
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
            callerSignal?.removeEventListener('abort', forwardAbort);
            // Only abort on the failure path. On success the caller still
            // needs the response body stream; aborting here would destroy it
            // (undici-backed fetch rejects response.json() with AbortError).
            // On success the detached controller is garbage-collected.
            if (!succeeded) {
                controller.abort();
            }
        }
    }

    private getRemainingBudget(deadline: number, totalBudgetMs: number): number {
        const remainingMs = deadline - this.clock();
        if (remainingMs <= 0) {
            throw new TimeoutException(`Deadline exhausted (budget: ${totalBudgetMs}ms): ${this.url}`);
        }
        return remainingMs;
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
            if (error instanceof TrialError) throw error;
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
            return classifyAbortError(error, this.url, this.options.signal, timeoutMs);
        }

        return new NetworkException(`Network failure: ${this.url}`, error);
    }
}
