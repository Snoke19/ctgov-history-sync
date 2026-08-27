import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { HttpResponse } from '../../../src/http/transport/httpTransport.js';
import { FetchOperation } from '../../../src/retry/fetchOperation.js';
import { Retry } from '../../../src/retry/retry.js';
import { shouldRetry } from '../../../src/retry/retryPolicy.js';
import { rejectOnAbort } from '../fixtures/abort.fixture.js';
import { createMockEndpoint, createMockEndpointManager } from '../fixtures/endpoint.fixture.js';
import { createMockHttpResponse } from '../fixtures/httpResponse.fixture.js';
import { createMockTransport } from '../fixtures/transport.fixture.js';

const URL = 'https://example.com/trials';
const USER_AGENT = 'TestAgent/1.0';
const RETRY_POLICY = {
    retryOnTimeout: true,
    retryOnNetworkError: true,
    retryableStatusCodes: new Set([429, 500, 502, 503, 504]),
    baseDelayMs: 1,
    backoffCapMs: 1_000,
};

type TransportOptions = {
    timeoutMs?: number;
};

function createOperation(options: TransportOptions = {}) {
    const transport = createMockTransport();
    const endpoint = createMockEndpoint(transport);
    const endpointManager = createMockEndpointManager(endpoint, 1);

    const operation = new FetchOperation(
        endpointManager,
        URL,
        options,
        {
            timeoutMs: 1_000,
            userAgent: USER_AGENT,
        },
    );

    return {
        transport,
        operation,
    };
}

function createRetry(
    operation: FetchOperation,
    sleep: jest.MockedFunction<(delayMs: number, signal?: AbortSignal) => Promise<void>>,
    maxAttempts = 2,
) {
    return new Retry(
        operation,
        maxAttempts,
        (error) => shouldRetry(error, RETRY_POLICY),
        () => 0,
        sleep,
    );
}

describe('Retry + FetchOperation integration', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('retries a network failure from FetchOperation and returns the successful response', async () => {
        const { transport, operation } = createOperation();
        const firstCause = Object.assign(new Error('connection reset'), {
            code: 'ECONNRESET',
        });
        const response = createMockHttpResponse();
        const sleep = jest.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        transport.request.mockRejectedValueOnce(firstCause).mockResolvedValueOnce(response);
        transport.classifyError.mockReturnValue({
            kind: 'network',
            cause: firstCause,
        });

        const retry = createRetry(operation, sleep);

        await expect(retry.perform()).resolves.toBe(response);

        expect(transport.request).toHaveBeenCalledTimes(2);
        expect(transport.classifyError).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(0, undefined);
    });

    it('retries an HTTP 503 from FetchOperation and returns the successful response', async () => {
        const { transport, operation } = createOperation();
        const failedResponse = createMockHttpResponse({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
        });
        const successfulResponse = createMockHttpResponse();
        const sleep = jest.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        transport.request.mockResolvedValueOnce(failedResponse).mockResolvedValueOnce(successfulResponse);

        const retry = createRetry(operation, sleep);

        await expect(retry.perform()).resolves.toBe(successfulResponse);

        expect(transport.request).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(0, undefined);
    });

    it('retries a timeout from FetchOperation and returns the successful response', async () => {
        const timeoutMs = 50;
        const transportAbortError = new Error('The operation was aborted.');
        const { transport, operation } = createOperation({ timeoutMs });
        const successfulResponse = createMockHttpResponse();
        const sleep = jest.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);

        transport.request
            .mockImplementationOnce((options) => {
                return new Promise<HttpResponse>((_, reject) => {
                    rejectOnAbort(options.signal, reject, transportAbortError);
                });
            })
            .mockResolvedValueOnce(successfulResponse);

        const retry = createRetry(operation, sleep);
        const promise = retry.perform();

        await jest.advanceTimersByTimeAsync(timeoutMs);

        await expect(promise).resolves.toBe(successfulResponse);

        expect(transport.request).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('does not retry a timeout when retry policy disables timeout retries', async () => {
        const timeoutMs = 50;
        const transportAbortError = new Error('The operation was aborted.');
        const { transport, operation } = createOperation({ timeoutMs });
        const sleep = jest.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined);
        const retry = new Retry(
            operation,
            3,
            (error) => shouldRetry(error, { ...RETRY_POLICY, retryOnTimeout: false }),
            () => 0,
            sleep,
        );

        transport.request.mockImplementation((options) => {
            return new Promise<HttpResponse>((_, reject) => {
                rejectOnAbort(options.signal, reject, transportAbortError);
            });
        });

        const promise = retry.perform();

        await jest.advanceTimersByTimeAsync(timeoutMs);

        await expect(promise).rejects.toBeInstanceOf(Error);

        expect(transport.request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });
});
