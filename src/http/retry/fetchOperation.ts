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
import { HttpResponse, HttpTransport } from '../endpoint/transport/httpTransport.js';
import { drainBody } from '../responseBody.js';
import { defaultClock } from '../types/clock.js';
import type { Clock } from '../types/clock.js';
import { FetchJsonRequestOptions } from '../types/http.js';
import { BusinessOperation } from './businessOperation.js';
import { parseRetryAfterHeader } from './retryPolicy.js';

type AbortReason = 'caller' | 'timeout';

export class FetchOperation implements BusinessOperation<HttpResponse> {
    /**
     * @param clock Clock source for budget/deadline math. Defaults to the
     * shared HTTP-layer clock (`Date.now()`).
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

        /**
         * Tracks the semantic reason for the controller abort.
         *
         * The transport must not infer this from the concrete error object,
         * because the underlying library may use completely different error
         * representations.
         */
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
            const remainingMs = this.getRemainingBudget(deadline, timeoutMs);
            const attemptBudget = Math.min(timeoutMs, remainingMs);

            /**
             * This timer represents OUR timeout, not a transport timeout.
             * Therefore the transport receives a normal AbortSignal and does
             * not need to know anything about timeout timers.
             */
            timeoutId = setTimeout(() => {
                abortReason = 'timeout';
                controller.abort();
            }, attemptBudget);

            const endpoint = await this.acquireEndpoint(attemptBudget, controller.signal);

            const response = await this.executeRequest(endpoint, controller.signal, () => abortReason);

            succeeded = true;
            return response;
        } catch (error) {
            /**
             * Endpoint acquisition can observe our aborted controller directly
             * and produce the canonical domain-level CallerAbortedError.
             */
            if (error instanceof CallerAbortedError) {
                throw this.mapAbortReason(error, abortReason, timeoutMs);
            }

            throw error;
        } finally {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }

            callerSignal?.removeEventListener('abort', forwardAbort);

            /**
             * Only abort on failure. On success the response body may still
             * need to be consumed.
             */
            if (!succeeded) {
                controller.abort();
            }
        }
    }

    private getRemainingBudget(deadline: number, timeoutMs: number): number {
        const remainingMs = deadline - this.clock();

        if (remainingMs <= 0) {
            throw new TimeoutException(`Deadline exhausted (timeout: ${timeoutMs}ms): ${this.url}`);
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
        } catch (error) {
            if (error instanceof TrialError) {
                throw error;
            }

            throw this.classifyTransportError(endpoint.transport, error, getAbortReason());
        }

        if (!response.ok) {
            const retryAfter = parseRetryAfterHeader(response, this.clock());

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
    ): NetworkException | TimeoutException {
        const timeoutMs = this.options.timeoutMs ?? FETCH_TIMEOUT_MS;
        const classification = transport.classifyError(error);

        switch (classification.kind) {
            case 'timeout':
                return new TimeoutException(`Request timed out after ${timeoutMs}ms: ${this.url}`);

            case 'cancelled':
                return this.mapAbortReason(classification.cause, abortReason, timeoutMs);

            case 'network':
                return new NetworkException(`Network failure: ${this.url}`, classification.cause);
        }
    }

    private mapAbortReason(
        cause: unknown,
        abortReason: AbortReason | undefined,
        timeoutMs: number,
    ): NetworkException | TimeoutException {
        if (abortReason === 'caller') {
            return new NetworkException(`Request cancelled by caller: ${this.url}`, cause);
        }

        return new TimeoutException(`Request timed out after ${timeoutMs}ms: ${this.url}`);
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
}
