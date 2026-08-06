import { DEFAULT_USER_AGENT, FETCH_TIMEOUT_MS } from '../config/config.js';
import { EndpointManager } from './endpoint/manager/endpointManager.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';
import { BusinessException } from './retry/businessException.js';
import { BusinessOperation } from './retry/businessOperation.js';
import { HttpException, NetworkException, TimeoutException } from './retry/exceptions.js';
import { parseRetryAfterHeader } from './retry/retryPolicy.js';
import { FetchJsonRequestOptions } from './types/http.js';

export class FetchOperation implements BusinessOperation<HttpResponse> {
    constructor(
        private readonly endpointManager: EndpointManager,
        private readonly url: string,
        private readonly options: FetchJsonRequestOptions,
    ) {}

    async perform(): Promise<HttpResponse> {
        const endpoint = await this.endpointManager.acquireEndpoint();

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, this.options.timeoutMs ?? FETCH_TIMEOUT_MS);

        try {
            const response = await endpoint.transport.request({
                url: this.url,
                method: this.options.method ?? 'GET',
                headers: {
                    Accept: 'application/json',
                    'User-Agent': DEFAULT_USER_AGENT,
                },
                body: this.options.body,
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new HttpException(
                    `HTTP ${response.status}`,
                    response.status,
                    parseRetryAfterHeader(response) ?? undefined,
                );
            }

            return response;
        } catch (error) {
            if (error instanceof BusinessException) {
                throw error;
            }

            if (error instanceof DOMException && error.name === 'AbortError') {
                throw new TimeoutException('Request timeout');
            }

            throw new NetworkException('Network failure', error);
        } finally {
            clearTimeout(timeout);
        }
    }
}
