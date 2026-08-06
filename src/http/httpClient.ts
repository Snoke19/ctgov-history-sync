import {
    ERROR_BODY_PREVIEW_LENGTH,
    MAX_RETRIES,
    RETRY_BASE_DELAY_MS,
    RETRYABLE_STATUS_CODES,
} from '../config/config.js';
import { EndpointFactory } from './endpoint/endpointFactory.js';
import { EndpointManagerFactory } from './endpoint/manager/endpointManagerFactory.js';
import { EndpointProvider } from './endpoint/provider/endpointProvider.js';
import { HttpResponse } from './endpoint/transport/httpTransport.js';
import { FetchOperation } from './fetchOperation.js';
import { DefaultLimiterFactory } from './limiter/factory/defaultLimiterFactory.js';
import { LimiterFactory } from './limiter/factory/limiterFactory.js';
import { parseJsonResponse } from './responseBody.js';
import { BusinessException } from './retry/businessException.js';
import { HttpException, NetworkException, TimeoutException } from './retry/exceptions.js';
import { Retry } from './retry/retry.js';
import { FetchJsonRequestOptions, HttpClientOptions } from './types/http.js';

export function createHttpClient(
    options: HttpClientOptions,
    provider: EndpointProvider,
    limiterFactory: LimiterFactory = new DefaultLimiterFactory(),
) {
    const endpointFactory = new EndpointFactory(provider, limiterFactory);

    const endpointManager = new EndpointManagerFactory(endpointFactory).create(options);

    async function fetchJson(url: string, request: FetchJsonRequestOptions) {
        const operation = new FetchOperation(endpointManager, url, request);

        const retry = new Retry<HttpResponse>(
            operation,
            request.maxRetries ?? MAX_RETRIES,
            RETRY_BASE_DELAY_MS,
            shouldRetry,
        );

        const response = await retry.perform();

        return parseJsonResponse(response, url, {
            errorBodyPreviewLength: ERROR_BODY_PREVIEW_LENGTH,
            retryableStatusCodes: RETRYABLE_STATUS_CODES,
        });
    }

    async function close() {
        await endpointManager.close();
    }

    return {
        fetchJson,
        close,
    };
}

function shouldRetry(error: BusinessException): boolean {
    if (error instanceof TimeoutException || error instanceof NetworkException) {
        return true;
    }

    return (
        error instanceof HttpException &&
        (error.status === 408 || error.status === 429 || error.status >= 500)
    );
}
